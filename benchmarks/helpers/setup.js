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
    throw new Error(`Bootstrap failed with status ${res.status}`);
  }
  const data = JSON.parse(res.body);
  
  const apiKey = data?.data?.apiKey || data?.apiKey;
  const orgId = data?.data?.organization?.id || data?.orgId;
  const serviceId = data?.data?.service?.id || data?.serviceId;
  
  if (!apiKey || !orgId || !serviceId) {
    throw new Error("Bootstrap failed: Missing required fields in response");
  }

  return {
    apiKey,
    orgId,
    serviceId,
  };
}

export function getAuthHeaders(apiKey) {
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

export { BASE_URL };
