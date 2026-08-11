import http from "k6/http";
import { check, sleep } from "k6";
import { bootstrap, getAuthHeaders, BASE_URL } from "./helpers/setup.js";

export const options = {
  scenarios: {
    service_traffic: {
      executor: "constant-vus",
      vus: 50,
      duration: "2m",
      exec: "serviceTraffic",
    },
    lease_churning: {
      executor: "constant-vus",
      vus: 10,
      duration: "2m",
      exec: "leaseChurning",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<10", "p(99)<20"],
    http_req_failed: ["rate<0.05"],
  },
};

export function setup() {
  return bootstrap();
}

export function serviceTraffic(data) {
  const res = http.post(`${BASE_URL}/api/ping`, null, {
    headers: getAuthHeaders(data.apiKey),
  });

  check(res, {
    "ping status is 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
}

export function leaseChurning(data) {
  const idempotencyKey = `${__VU}-${__ITER}-${Date.now()}`;
  const headers = Object.assign({}, getAuthHeaders(data.apiKey), {
    "X-Idempotency-Key": idempotencyKey,
  });

  const claimRes = http.post(
    `${BASE_URL}/quota/leases`,
    JSON.stringify({
      amount: 100,
      ttlSeconds: 30,
    }),
    { headers },
  );

  check(claimRes, {
    "lease claimed successfully": (r) => r.status === 201 || r.status === 200,
  });

  if (claimRes.status === 201 || claimRes.status === 200) {
    const leaseId = JSON.parse(claimRes.body).data.id;
    sleep(5);

    const releaseRes = http.del(`${BASE_URL}/quota/leases/${leaseId}`, null, {
      headers: getAuthHeaders(data.apiKey),
    });

    check(releaseRes, {
      "lease released successfully": (r) =>
        r.status === 200 || r.status === 204,
    });
  }
}
