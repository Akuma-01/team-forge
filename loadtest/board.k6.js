/* global open, __ENV, __VU, __ITER */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Rate, Counter } from 'k6/metrics';
import exec from 'k6/execution';

// Load seeded tokens
const tokens = new SharedArray('tokens', () => {
  const values = JSON.parse(open(__ENV.TOKENS_FILE || './tokens.json'));
  if (!Array.isArray(values) || values.length < 200 || values.some((token) => typeof token !== 'string' || !token)) {
    throw new Error('Seeded tokens are missing or invalid. Run the guarded seed before benchmarking.');
  }
  return values;
});

// Environment configuration
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8080';
const HACKATHON_ID = __ENV.HACKATHON_ID || '00000000-0000-4000-a000-000000000001';
const SCENARIO_TYPE = __ENV.SCENARIO || 'realistic'; // 'realistic' or 'stress'
const THINK_SECONDS = SCENARIO_TYPE === 'realistic' ? Number(__ENV.THINK_SECONDS || 1) : 0;

const SKILLS = [
  'frontend', 'backend', 'design', 'ml', 'data',
  'mobile', 'devops', 'security', 'product', 'blockchain',
];

// Custom metrics to separate successful latencies from failure responses
const successfulDuration = new Trend('successful_board_duration', true);
const failureRate = new Rate('board_failure_rate');
const rateLimitCounter = new Counter('rate_limit_errors');
const timeoutCounter = new Counter('timeout_errors');

export const options = {
  scenarios: {
    // 10-second warm-up phase (excluded from reported measurements)
    warmup: {
      executor: 'constant-vus',
      vus: 20,
      duration: '10s',
      gracefulStop: '0s',
      tags: { phase: 'warmup' },
    },
    // 60-second primary measurement phase with 100 concurrent VUs
    measurement: {
      executor: 'constant-vus',
      vus: 100,
      startTime: '10s',
      duration: '60s',
      tags: { phase: 'measurement' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    'http_req_failed{phase:measurement}': ['rate<0.01'],
    'board_failure_rate{phase:measurement}': ['rate<0.01'],
    'successful_board_duration{phase:measurement}': ['p(95)<200'],
  },
};

// Setup step to fetch an initial cursor for second-page requests
export function setup() {
  const token = tokens[0] || '';
  const res = http.get(`${BASE_URL}/api/hackathons/${HACKATHON_ID}/teams?limit=30`, {
    headers: {
      Cookie: `sid=${token}`,
      Accept: 'application/json',
    },
    timeout: '5s',
    tags: { phase: 'setup', name: 'board_setup' },
  });
  if (res.status !== 200) throw new Error(`Board setup failed with HTTP ${res.status}; check token expiry and target database.`);
  const body = res.json();
  if (!Array.isArray(body.items) || body.items.length !== 30 || typeof body.nextCursor !== 'string' || !body.nextCursor) {
    throw new Error('Seeded board setup must return 30 teams and a real second-page cursor.');
  }
  return { initialCursor: body.nextCursor };
}

export default function (data) {
  // Rotate tokens across iterations and VUs to represent authentic multi-user traffic
  const tokenIndex = (__VU - 1 + __ITER) % tokens.length;
  const token = tokens[tokenIndex];

  const roll = Math.random();
  let url = `${BASE_URL}/api/hackathons/${HACKATHON_ID}/teams?limit=30`;
  let requestType = 'first_page';

  if (roll < 0.70) {
    // 70%: First page unfiltered
    requestType = 'first_page';
  } else if (roll < 0.90) {
    // 20%: Filtered by skill
    const skill = SKILLS[Math.floor(Math.random() * SKILLS.length)];
    url += `&needs=${skill}`;
    requestType = 'skill_filtered';
  } else {
    // 10%: Second-page cursor request
    url += `&cursor=${encodeURIComponent(data.initialCursor)}`;
    requestType = 'second_page_cursor';
  }

  const tagPhase = exec.scenario.name === 'warmup' ? 'warmup' : 'measurement';
  const res = http.get(url, {
    headers: {
      Cookie: `sid=${token}`,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    },
    tags: {
      name: 'board',
      request_type: requestType,
      phase: tagPhase,
    },
    timeout: '5s',
  });

  const isSuccess = res.status === 200;
  const isRateLimited = res.status === 429;
  const isTimeout = res.status === 0;

  if (isSuccess) {
    successfulDuration.add(res.timings.duration, { phase: tagPhase });
    failureRate.add(0, { phase: tagPhase });


  } else {
    failureRate.add(1, { phase: tagPhase });
    if (isRateLimited) rateLimitCounter.add(1, { phase: tagPhase });
    if (isTimeout) timeoutCounter.add(1, { phase: tagPhase });
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
    'latency under 200ms': (r) => r.timings.duration < 200,
  });

  if (THINK_SECONDS > 0) {
    sleep(THINK_SECONDS);
  }
}
