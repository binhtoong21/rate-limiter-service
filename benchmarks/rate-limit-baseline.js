import http from "k6/http";
import { check } from "k6";
import { bootstrap, getAuthHeaders, BASE_URL } from "./helpers/setup.js";

export const options = {
  stages: [
    { duration: "30s", target: 100 }, // ramp up
    { duration: "2m", target: 100 }, // steady
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<5", "p(99)<10"],
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  return bootstrap();
}

export default function (data) {
  const res = http.post(`${BASE_URL}/api/ping`, "{}", {
    headers: getAuthHeaders(data.apiKey),
    responseCallback: http.expectedStatuses(200, 429),
  });

  check(res, {
    "is status 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
}
