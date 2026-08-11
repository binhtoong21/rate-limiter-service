import http from "k6/http";
import { check } from "k6";
import { bootstrap, getAuthHeaders, BASE_URL } from "./helpers/setup.js";

// Run with:
// RATE_LIMIT_ALGORITHM=sliding_window k6 run algorithm-comparison.js
// RATE_LIMIT_ALGORITHM=token_bucket k6 run algorithm-comparison.js

export const options = {
  vus: 50,
  duration: '10s',
  thresholds: {
    http_req_duration: ['p(99)<15'],
  },
};

export function setup() {
  const algorithm = __ENV.RATE_LIMIT_ALGORITHM || "sliding_window (default)";
  console.log(`Running algorithm comparison test with algorithm: ${algorithm}`);
  return bootstrap();
}

export default function (data) {
  const res = http.post(`${BASE_URL}/api/ping`, "{}", {
    headers: getAuthHeaders(data.apiKey),
  });

  check(res, {
    "is status 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
}
