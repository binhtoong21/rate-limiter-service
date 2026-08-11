import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { bootstrap, getAuthHeaders, BASE_URL } from "./helpers/setup.js";

const rateLimitHits = new Counter("rate_limit_hits");

export const options = {
  stages: [
    { duration: "10s", target: 500 }, // spike
    { duration: "30s", target: 500 }, // sustain
    { duration: "10s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ["rate<0.02"], // Allow < 2% non-429 errors
  },
};

export function setup() {
  return bootstrap();
}

export default function (data) {
  const res = http.post(`${BASE_URL}/api/ping`, null, {
    headers: getAuthHeaders(data.apiKey),
  });

  if (res.status === 429) {
    rateLimitHits.add(1);
  }

  check(res, {
    "is status 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
}
