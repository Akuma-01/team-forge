/* global open, __ENV, __VU, __ITER */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Rate, Counter } from 'k6/metrics';

// Load seeded tokens
const tokens = new SharedArray('tokens', () => {
  try {
    return JSON.parse(open('./tokens.json'));
  } catch {
    return ['ci-fallback-token'];
  }
});

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8080';
const HACKATHON_ID = __ENV.HACKATHON_ID || '00000000-0000-4000-a000-000000000001';

const SKILLS = [
  'frontend', 'backend', 'design', 'ml', 'data',
  'mobile', 'devops', 'security', 'product', 'blockchain',
];

const successfulDuration = new Trend('successful_board_duration', true);
const failureRate = new Rate('board_failure_rate');
const timeoutCounter = new Counter('timeout_errors');

export const options = {
  scenarios: {
    // 20-second CI performance smoke test with 10 VUs
    ci_smoke: {
      executor: 'constant-vus',
      vus: 10,
      duration: '20s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    board_failure_rate: ['rate<0.01'],
    // 500ms threshold is resilient on shared 2-core GitHub Actions runners
    successful_board_duration: ['p(95)<500'],
  },
};

export function setup() {
  const token = tokens[0] || '';
  const res = http.get(`${BASE_URL}/api/hackathons/${HACKATHON_ID}/teams?limit=30`, {
    headers: {
      Cookie: `sid=${token}`,
      Accept: 'application/json',
    },
  });
  let initialCursor = null;
  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      initialCursor = data.nextCursor;
    } catch {
      // ignore
    }
  }
  return { initialCursor };
}

let vuCursor = null;

export default function (data) {
  const tokenIndex = (__VU * 1000 + __ITER) % tokens.length;
  const token = tokens[tokenIndex];

  const roll = Math.random();
  let url = `${BASE_URL}/api/hackathons/${HACKATHON_ID}/teams?limit=30`;
  let requestType = 'first_page';

  if (roll < 0.70) {
    requestType = 'first_page';
  } else if (roll < 0.90) {
    const skill = SKILLS[Math.floor(Math.random() * SKILLS.length)];
    url += `&needs=${skill}`;
    requestType = 'skill_filtered';
  } else {
    const cursor = vuCursor || data.initialCursor;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
      requestType = 'second_page_cursor';
    } else {
      requestType = 'first_page';
    }
  }

  const res = http.get(url, {
    headers: {
      Cookie: `sid=${token}`,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    },
    tags: {
      name: 'ci_board_smoke',
      request_type: requestType,
    },
    timeout: '5s',
  });

  const isSuccess = res.status === 200;
  const isTimeout = res.status === 0 || res.timings.duration >= 5000;

  if (isSuccess) {
    successfulDuration.add(res.timings.duration);
    failureRate.add(0);

    try {
      const body = JSON.parse(res.body);
      if (body.nextCursor) {
        vuCursor = body.nextCursor;
      }
    } catch {
      // ignore
    }
  } else {
    failureRate.add(1);
    if (isTimeout) timeoutCounter.add(1);
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  // Short 100ms pacing between requests to simulate active users without hammering shared CI CPU
  sleep(0.1);
}
