import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export function bootstrap() {
  const res = http.post(
    `${BASE_URL}/dev/bootstrap`,
    JSON.stringify({
      orgSlug: `bench-org-${Date.now()}`,
      orgName: "Benchmark Org",
      serviceName: "bench-service",
      quotaAllocated: 100000,
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );

  if (res.status !== 200) {
    console.log("Bootstrap failed:", res.status, res.body);
  }
  const data = JSON.parse(res.body);
  return {
    apiKey: data.apiKey,
    orgId: data.organization.id,
    serviceId: data.service.id,
  };
}

export function getAuthHeaders(apiKey) {
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

export { BASE_URL };
