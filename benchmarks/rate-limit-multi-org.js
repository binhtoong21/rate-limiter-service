import http from "k6/http";
import { check } from "k6";
import { BASE_URL } from "./helpers/setup.js";

const ORG_COUNT = 20;

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '2m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<10", "p(99)<25"],
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  const orgs = [];
  for (let i = 0; i < ORG_COUNT; i++) {
    const res = http.post(
      `${BASE_URL}/dev/bootstrap`,
      JSON.stringify({
        orgSlug: `bench-multi-${Date.now()}-${i}`,
        orgName: `Benchmark Org ${i}`,
        serviceName: "bench-service",
        quotaAllocated: 100000,
      }),
      { headers: { "Content-Type": "application/json" } },
    );

    if (res.status !== 200 && res.status !== 201) {
      console.log(`Bootstrap org ${i} failed:`, res.status, res.body);
      throw new Error(`Bootstrap failed for org ${i}`);
    }
    const data = JSON.parse(res.body);
    const d = data.data || data;
    orgs.push({
      apiKey: d.apiKey,
      orgId: d.organization ? d.organization.id : d.orgId,
      serviceId: d.service ? d.service.id : d.serviceId,
    });
  }
  console.log(`Bootstrapped ${orgs.length} orgs for multi-org benchmark`);
  return { orgs: orgs };
}

export default function (data) {
  // Each VU picks a random org, distributing load across Redis keys
  var idx = Math.floor(Math.random() * data.orgs.length);
  var org = data.orgs[idx];

  var res = http.post(`${BASE_URL}/api/ping`, "{}", {
    headers: {
      "X-API-Key": org.apiKey,
      "Content-Type": "application/json",
    },
    responseCallback: http.expectedStatuses(200, 429),
  });

  check(res, {
    "is status 200 or 429": function(r) { return r.status === 200 || r.status === 429; },
  });
}
