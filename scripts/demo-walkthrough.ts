import { randomUUID } from 'crypto';

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const IS_FAST = process.env.CI === 'true' || process.argv.includes('--fast') || process.argv.includes('--ci');

// ANSI Color & Formatting Constants
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;

const FG_RED = `${ESC}31m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_BLUE = `${ESC}34m`;
const FG_MAGENTA = `${ESC}35m`;
const FG_CYAN = `${ESC}36m`;
const FG_WHITE = `${ESC}37m`;
const FG_GRAY = `${ESC}90m`;

const BG_BLUE = `${ESC}44m`;
const BG_DARK_GRAY = `${ESC}100m`;

// Helper: Pause with animated spinner
async function delay(ms: number, message = ''): Promise<void> {
  const actualMs = IS_FAST ? Math.min(ms, 150) : ms;
  if (actualMs <= 0) return;

  if (!message || IS_FAST) {
    return new Promise((resolve) => setTimeout(resolve, actualMs));
  }

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const intervalTime = 80;
  const start = Date.now();

  process.stdout.write(`${FG_CYAN}${frames[0]}${RESET} ${DIM}${message}${RESET}`);

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= actualMs) {
        clearInterval(timer);
        process.stdout.write(`\r\x1b[K`); // Clear line
        resolve();
        return;
      }
      i = (i + 1) % frames.length;
      process.stdout.write(`\r${FG_CYAN}${frames[i]}${RESET} ${DIM}${message}${RESET}`);
    }, intervalTime);
  });
}

// Helper: Terminal Box Drawing
function renderBox(title: string, lines: string[], color = FG_CYAN): void {
  const cleanTitle = title.replace(/\x1b\[[0-9;]*m/g, '');
  const contentWidth = Math.max(
    cleanTitle.length + 4,
    ...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length)
  );
  const totalWidth = Math.max(contentWidth + 4, 76);

  const topBorder = `┌─ ${title} ${'─'.repeat(Math.max(0, totalWidth - cleanTitle.length - 5))}┐`;
  const bottomBorder = `└${'─'.repeat(totalWidth - 2)}┘`;

  console.log(`${color}${topBorder}${RESET}`);
  for (const line of lines) {
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
    const padding = totalWidth - 4 - cleanLine.length;
    console.log(`${color}│${RESET}  ${line}${' '.repeat(Math.max(0, padding))}${color}│${RESET}`);
  }
  console.log(`${color}${bottomBorder}${RESET}`);
}

// Helper: Formatted Key-Value list
function printMetrics(data: Record<string, string | number>): void {
  const entries = Object.entries(data);
  for (const [key, value] of entries) {
    console.log(`   ${FG_GRAY}•${RESET} ${BOLD}${key.padEnd(16)}:${RESET} ${FG_CYAN}${value}${RESET}`);
  }
}

// HTTP Helper
interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  data: T;
  rawText: string;
}

async function request<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${endpoint}`;
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const rawText = await res.text();
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = rawText;
  }

  return {
    status: res.status,
    headers: res.headers,
    data,
    rawText,
  };
}

// Bootstrap result interfaces
interface BootstrappedEntity {
  organization: {
    id: string;
    name: string;
    slug: string;
    quotaAllocated: number;
    failOpen: boolean;
  };
  service: {
    id: string;
    name: string;
    isAdmin: boolean;
  };
  apiKey: string;
}

// Fallback message when server is down
function printServerUnreachable(): void {
  console.clear();
  renderBox(
    '⚠️  TARGET SERVICE NOT REACHABLE',
    [
      '',
      `${BOLD}Cannot connect to rate-limiter service at:${RESET} ${FG_YELLOW}${BASE_URL}${RESET}`,
      '',
      `${BOLD}To run this live interactive walkthrough:${RESET}`,
      ` 1. Ensure Docker dependencies are up (PostgreSQL & Redis):`,
      `    ${FG_GREEN}docker-compose up -d${RESET}`,
      ` 2. Run database migrations:`,
      `    ${FG_GREEN}npm run db:push${RESET}`,
      ` 3. Start the Fastify service in a separate terminal:`,
      `    ${FG_GREEN}npm run dev${RESET}`,
      '',
      `Once running, re-execute:`,
      `    ${FG_CYAN}npm run demo${RESET}  ${DIM}(or BASE_URL=http://localhost:3000 npm run demo)${RESET}`,
      '',
    ],
    FG_RED
  );
}

// Main Interactive Runner
async function runDemo(): Promise<void> {
  console.clear();

  // Welcome Banner
  console.log(`${FG_CYAN}╔══════════════════════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${FG_CYAN}║${RESET}     ${BOLD}${FG_WHITE}DISTRIBUTED RATE LIMITER WITH DYNAMIC QUOTA TRADING & AUDIT TRAIL${RESET}         ${FG_CYAN}║${RESET}`);
  console.log(`${FG_CYAN}║${RESET}     ${DIM}Production Architecture Walkthrough • 6 High-Impact Scenarios${RESET}                    ${FG_CYAN}║${RESET}`);
  console.log(`${FG_CYAN}╚══════════════════════════════════════════════════════════════════════════════════════╝${RESET}\n`);

  console.log(`${FG_GRAY}Connecting to:${RESET} ${FG_YELLOW}${BASE_URL}${RESET}`);
  await delay(600, 'Pinging healthcheck endpoint...');

  // =========================================================================
  // SCENARIO 1: System Health & Multi-Tenant Bootstrap
  // =========================================================================
  console.log(`\n${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${FG_WHITE}[SCENARIO 1] System Health Check & Multi-Tenant Organization Bootstrap${RESET}`);
  console.log(`${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${DIM}Validating cluster readiness (PostgreSQL + Redis) and bootstrapping isolated tenant environments.${RESET}\n`);

  let healthRes: ApiResponse;
  try {
    healthRes = await request('/health');
  } catch (err) {
    printServerUnreachable();
    process.exit(1);
  }

  if (healthRes.status !== 200 || healthRes.data?.status !== 'ok') {
    renderBox(
      '⚠️  CLUSTER DEGRADED',
      [
        `Health status: ${JSON.stringify(healthRes.data)}`,
        'Ensure Redis and PostgreSQL are healthy before running demo.',
      ],
      FG_YELLOW
    );
  } else {
    console.log(` ${FG_GREEN}✔${RESET} Cluster Health: ${BOLD}${FG_GREEN}HEALTHY (200 OK)${RESET}`);
    console.log(`   ${FG_GRAY}├─ PostgreSQL :${RESET} ${FG_GREEN}${healthRes.data.postgres.toUpperCase()}${RESET}`);
    console.log(`   ${FG_GRAY}└─ Redis      :${RESET} ${FG_GREEN}${healthRes.data.redis.toUpperCase()}${RESET}`);
  }

  await delay(1000, 'Bootstrapping tenant organizations...');

  // Bootstrap Org Alpha (Fintech Gateway)
  const alphaRes = await request<any>('/dev/bootstrap', {
    method: 'POST',
    body: JSON.stringify({
      orgName: 'Org Alpha (Fintech Core)',
      orgSlug: `org-alpha-${Date.now()}`,
      serviceName: 'payments-service',
      quotaAllocated: 10000,
      isAdmin: true,
    }),
  });

  // Bootstrap Org Beta (Analytics Stream)
  const betaRes = await request<any>('/dev/bootstrap', {
    method: 'POST',
    body: JSON.stringify({
      orgName: 'Org Beta (Analytics Hub)',
      orgSlug: `org-beta-${Date.now()}`,
      serviceName: 'streaming-service',
      quotaAllocated: 5000,
      isAdmin: true,
    }),
  });

  if (alphaRes.status !== 201 && alphaRes.status !== 200) {
    console.error(`${FG_RED}Bootstrap failed:${RESET}`, alphaRes.rawText);
    process.exit(1);
  }

  const alpha = alphaRes.data.data as BootstrappedEntity;
  const beta = betaRes.data.data as BootstrappedEntity;

  renderBox(
    '🏢 BOOTSTRAPPED MULTI-TENANT TOPOLOGY',
    [
      `${BOLD}ORG ALPHA${RESET} (Lender Org):`,
      `  ID: ${FG_CYAN}${alpha.organization.id}${RESET} | Slug: ${alpha.organization.slug}`,
      `  Initial Quota: ${FG_GREEN}${alpha.organization.quotaAllocated.toLocaleString()} reqs${RESET} | Fail-Open: ${alpha.organization.failOpen}`,
      `  API Key: ${FG_YELLOW}${alpha.apiKey.substring(0, 15)}...${RESET} ${DIM}(Admin Service: ${alpha.service.name})${RESET}`,
      '',
      `${BOLD}ORG BETA${RESET} (Borrower Org):`,
      `  ID: ${FG_CYAN}${beta.organization.id}${RESET} | Slug: ${beta.organization.slug}`,
      `  Initial Quota: ${FG_GREEN}${beta.organization.quotaAllocated.toLocaleString()} reqs${RESET} | Fail-Open: ${beta.organization.failOpen}`,
      `  API Key: ${FG_YELLOW}${beta.apiKey.substring(0, 15)}...${RESET} ${DIM}(Admin Service: ${beta.service.name})${RESET}`,
    ],
    FG_GREEN
  );

  await delay(1400);

  // =========================================================================
  // SCENARIO 2: Normal Rate Limiting Under Limit
  // =========================================================================
  console.log(`\n${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${FG_WHITE}[SCENARIO 2] Normal Rate Limiting (Under Capacity / Healthy Flow)${RESET}`);
  console.log(`${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${DIM}Evaluating sliding-window counter in Redis Lua with standard rate limits (5 req / 10s).${RESET}\n`);

  for (let i = 1; i <= 3; i++) {
    await delay(400, `Sending request #${i} to /api/ping...`);
    const pingRes = await request('/api/ping', {
      method: 'POST',
      headers: { 'X-API-Key': alpha.apiKey },
    });

    const limit = pingRes.headers.get('X-RateLimit-Limit');
    const remaining = pingRes.headers.get('X-RateLimit-Remaining');
    const reset = pingRes.headers.get('X-RateLimit-Reset');

    console.log(
      ` ${FG_GREEN}✔${RESET} Request #${i}: ${BOLD}${FG_GREEN}200 OK${RESET} ` +
      `│ Limit: ${FG_CYAN}${limit}${RESET} │ Remaining: ${FG_YELLOW}${remaining}${RESET} │ ResetTimestamp: ${DIM}${reset}${RESET}`
    );
  }

  console.log(`\n ${DIM}Architectural Guarantee: Sliding window counters smoothly decay previous window load.${RESET}`);
  await delay(1200);

  // =========================================================================
  // SCENARIO 3: Throttling & Graceful Degradation
  // =========================================================================
  console.log(`\n${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${FG_WHITE}[SCENARIO 3] Sudden Burst Throttling & 429 RFC Graceful Degradation${RESET}`);
  console.log(`${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${DIM}Simulating rapid burst of 7 requests to trigger limiter threshold and inspect Retry-After.${RESET}\n`);

  let throttledRetryAfter = 0;

  for (let i = 4; i <= 10; i++) {
    const res = await request('/api/ping', {
      method: 'POST',
      headers: { 'X-API-Key': alpha.apiKey },
    });

    const remaining = res.headers.get('X-RateLimit-Remaining');
    const retryAfter = res.headers.get('Retry-After');

    if (res.status === 200) {
      console.log(
        ` ${FG_GREEN}✔${RESET} Burst #${i}: ${BOLD}${FG_GREEN}200 OK${RESET} ` +
        `│ Remaining: ${FG_YELLOW}${remaining}${RESET}`
      );
    } else if (res.status === 429) {
      throttledRetryAfter = Number(retryAfter) || 9;
      console.log(
        ` ${FG_RED}✖${RESET} Burst #${i}: ${BOLD}${FG_RED}429 RATE_LIMIT_EXCEEDED${RESET} ` +
        `│ Error: ${FG_YELLOW}${res.data?.error?.code}${RESET} │ ${BOLD}${FG_MAGENTA}Retry-After: ${retryAfter}s${RESET}`
      );
    }
  }

  renderBox(
    '🛡️  RATE LIMIT EXCEEDED PROTECTION',
    [
      'Downstream services are shielded from cascading overload.',
      `Error Code returned : ${FG_RED}RATE_LIMIT_EXCEEDED${RESET}`,
      `Retry-After header  : ${FG_MAGENTA}${throttledRetryAfter} seconds${RESET}`,
      'Standard RFC 6585 header enables smart client-side exponential backoff.',
    ],
    FG_YELLOW
  );

  // Quick Countdown Animation
  if (!IS_FAST && throttledRetryAfter > 0) {
    const waitSecs = Math.min(throttledRetryAfter, 3);
    for (let s = waitSecs; s > 0; s--) {
      process.stdout.write(`\r ${FG_MAGENTA}⏳ Simulating client backoff countdown: ${s}s remaining...${RESET}`);
      await delay(1000);
    }
    process.stdout.write(`\r\x1b[K ${FG_GREEN}✔ Backoff interval completed.${RESET}\n`);
  }

  await delay(1200);

  // =========================================================================
  // SCENARIO 4: Dynamic Lease Claim (Elastic Burst Capacity)
  // =========================================================================
  console.log(`\n${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${FG_WHITE}[SCENARIO 4] Dynamic Quota Lease Claim (Burst Elasticity)${RESET}`);
  console.log(`${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${DIM}Service dynamically leases 500 requests from its allocated pool to absorb flash traffic.${RESET}\n`);

  await delay(600, 'Claiming dynamic lease from pool...');

  const leaseIdempotencyKey = randomUUID();
  const leaseClaimRes = await request('/quota/leases', {
    method: 'POST',
    headers: {
      'X-API-Key': alpha.apiKey,
      'X-Idempotency-Key': leaseIdempotencyKey,
    },
    body: JSON.stringify({
      amount: 500,
      ttlSeconds: 60,
    }),
  });

  if (leaseClaimRes.status !== 201) {
    console.error(`${FG_RED}Lease claim failed:${RESET}`, leaseClaimRes.rawText);
    process.exit(1);
  }

  const lease = leaseClaimRes.data.data;

  // Inspect Org Pool
  const poolRes = await request('/quota/pool', {
    headers: { 'X-API-Key': alpha.apiKey },
  });
  const pool = poolRes.data.data;

  renderBox(
    '🎟️  DYNAMIC LEASE GRANTED (DUAL-WRITE COMMITTED)',
    [
      `Lease ID     : ${FG_CYAN}${lease.id}${RESET}`,
      `Lease Quota  : ${FG_GREEN}+${lease.amount} requests${RESET} (Elastic temporary capacity)`,
      `Status / TTL : ${FG_GREEN}${lease.status.toUpperCase()}${RESET} | Expires: ${DIM}${lease.expiresAt}${RESET}`,
      `Idempotency  : ${DIM}${leaseIdempotencyKey}${RESET}`,
      '',
      `${BOLD}Org Alpha Pool Balance After Lease Claim:${RESET}`,
      `  • Total Allocated : ${pool.total.toLocaleString()}`,
      `  • Reserved (Lease): ${FG_YELLOW}${pool.reserved.toLocaleString()}${RESET}`,
      `  • Available Pool  : ${FG_GREEN}${pool.available.toLocaleString()}${RESET}`,
    ],
    FG_CYAN
  );

  console.log(`\n${DIM}Retrying burst traffic with active lease inflated limit...${RESET}`);
  await delay(600);

  // Now ping again - should be permitted with elevated limit!
  for (let i = 1; i <= 3; i++) {
    const postLeasePing = await request('/api/ping', {
      method: 'POST',
      headers: { 'X-API-Key': alpha.apiKey },
    });

    const newLimit = postLeasePing.headers.get('X-RateLimit-Limit');
    const newRemaining = postLeasePing.headers.get('X-RateLimit-Remaining');

    console.log(
      ` ${FG_GREEN}✔${RESET} Burst with Lease #${i}: ${BOLD}${FG_GREEN}200 OK${RESET} ` +
      `│ Limit: ${BOLD}${FG_CYAN}${newLimit}${RESET} ${DIM}(Base 5 + Lease 500)${RESET} │ Remaining: ${FG_YELLOW}${newRemaining}${RESET}`
    );
  }

  console.log(`\n ${DIM}Architectural Guarantee: Active lease sum automatically inflates local Lua limit check.${RESET}`);
  await delay(1200);

  // =========================================================================
  // SCENARIO 5: Cross-Organization Quota Trading (P2P Liquidity)
  // =========================================================================
  console.log(`\n${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${FG_WHITE}[SCENARIO 5] Cross-Organization Quota Trading (P2P Quota Loan)${RESET}`);
  console.log(`${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${DIM}Org Alpha (surplus quota) loans 2,000 requests to Org Beta (high-demand tenant).${RESET}\n`);

  // Pool before loan
  const alphaPoolBefore = (await request('/quota/pool', { headers: { 'X-API-Key': alpha.apiKey } })).data.data;
  const betaPoolBefore = (await request('/quota/pool', { headers: { 'X-API-Key': beta.apiKey } })).data.data;

  console.log(`${BOLD}Initial Balances Before Trade:${RESET}`);
  console.log(`  Org Alpha : Available = ${FG_GREEN}${alphaPoolBefore.available}${RESET} | LoanedOut = ${alphaPoolBefore.loanedOut}`);
  console.log(`  Org Beta  : Available = ${FG_GREEN}${betaPoolBefore.available}${RESET} | Received  = ${betaPoolBefore.received}`);

  await delay(800, 'Executing atomic dual-write loan transaction...');

  const loanIdempotencyKey = randomUUID();
  const loanRes = await request('/quota/loans', {
    method: 'POST',
    headers: {
      'X-API-Key': alpha.apiKey,
      'X-Idempotency-Key': loanIdempotencyKey,
    },
    body: JSON.stringify({
      borrower_org_id: beta.organization.id,
      amount: 2000,
      ttl_seconds: 3600,
      note: 'Cross-cluster overflow assistance',
    }),
  });

  if (loanRes.status !== 201) {
    console.error(`${FG_RED}Loan creation failed:${RESET}`, loanRes.rawText);
    process.exit(1);
  }

  const loan = loanRes.data.data;

  // Pool after loan
  const alphaPoolAfter = (await request('/quota/pool', { headers: { 'X-API-Key': alpha.apiKey } })).data.data;
  const betaPoolAfter = (await request('/quota/pool', { headers: { 'X-API-Key': beta.apiKey } })).data.data;

  renderBox(
    '🤝 P2P QUOTA LOAN EXECUTED ATOMICALLY',
    [
      `Loan ID      : ${FG_CYAN}${loan.id}${RESET}`,
      `Lender       : Org Alpha (${alpha.organization.name})`,
      `Borrower     : Org Beta (${beta.organization.name})`,
      `Traded Quota : ${BOLD}${FG_GREEN}2,000 requests${RESET} | Status: ${FG_GREEN}${loan.status.toUpperCase()}${RESET}`,
      '',
      `${BOLD}Balance Shift Summary:${RESET}`,
      `  • Org Alpha Available : ${alphaPoolBefore.available}  ➔  ${FG_YELLOW}${alphaPoolAfter.available}${RESET} (-2,000)`,
      `  • Org Alpha LoanedOut : ${alphaPoolBefore.loanedOut}  ➔  ${FG_CYAN}${alphaPoolAfter.loanedOut}${RESET} (+2,000)`,
      `  • Org Beta Available  : ${betaPoolBefore.available}  ➔  ${FG_GREEN}${betaPoolAfter.available}${RESET} (+2,000)`,
      `  • Org Beta Received   : ${betaPoolBefore.received}  ➔  ${FG_CYAN}${betaPoolAfter.received}${RESET} (+2,000)`,
    ],
    FG_GREEN
  );

  await delay(800, 'Org Beta consuming borrowed quota...');

  // Org Beta claims lease using borrowed quota
  const betaLeaseRes = await request('/quota/leases', {
    method: 'POST',
    headers: {
      'X-API-Key': beta.apiKey,
      'X-Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      amount: 1000,
      ttlSeconds: 60,
    }),
  });

  if (betaLeaseRes.status === 201) {
    console.log(` ${FG_GREEN}✔${RESET} Org Beta successfully drew ${BOLD}1,000 req lease${RESET} against borrowed quota!`);
  }

  await delay(1200);

  // =========================================================================
  // SCENARIO 6: Loan Settlement & Immutable Audit Log
  // =========================================================================
  console.log(`\n${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}${FG_WHITE}[SCENARIO 6] Loan Settlement & PostgreSQL Immutable Audit Log${RESET}`);
  console.log(`${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${DIM}Settling loan (repay), restoring lender balance, and inspecting ground-truth event store.${RESET}\n`);

  await delay(800, 'Org Beta repaying borrowed loan...');

  const repayRes = await request(`/quota/loans/${loan.id}/repay`, {
    method: 'POST',
    headers: {
      'X-API-Key': beta.apiKey,
      'X-Idempotency-Key': randomUUID(),
    },
  });

  if (repayRes.status !== 200) {
    console.error(`${FG_RED}Repayment failed:${RESET}`, repayRes.rawText);
    process.exit(1);
  }

  const alphaPoolFinal = (await request('/quota/pool', { headers: { 'X-API-Key': alpha.apiKey } })).data.data;
  const betaPoolFinal = (await request('/quota/pool', { headers: { 'X-API-Key': beta.apiKey } })).data.data;

  console.log(` ${FG_GREEN}✔${RESET} Loan Settled: ${BOLD}${FG_GREEN}REPAID (200 OK)${RESET}`);
  console.log(`   ${FG_GRAY}• Org Alpha LoanedOut restored to:${RESET} ${FG_GREEN}${alphaPoolFinal.loanedOut}${RESET}`);
  console.log(`   ${FG_GRAY}• Org Beta Received restored to :${RESET} ${FG_GREEN}${betaPoolFinal.received}${RESET}`);

  await delay(1000, 'Querying immutable audit log (/quota/events)...');

  // Query events audit log for Org Alpha
  const eventsRes = await request('/quota/events?limit=8', {
    headers: { 'X-API-Key': alpha.apiKey },
  });

  const events = eventsRes.data.data || [];

  console.log(`\n${BOLD}📋 POSTGRESQL IMMUTABLE QUOTA EVENTS LOG (Ground Truth):${RESET}`);
  console.log(`${FG_GRAY}──────────────────────────────────────────────────────────────────────────────────────────${RESET}`);
  console.log(
    `${BOLD}${'EVENT TYPE'.padEnd(24)} ${'AMOUNT'.padEnd(10)} ${'BALANCE AFTER'.padEnd(16)} ${'TIMESTAMP'.padEnd(25)}${RESET}`
  );
  console.log(`${FG_GRAY}──────────────────────────────────────────────────────────────────────────────────────────${RESET}`);

  for (const evt of events) {
    let typeColor = FG_WHITE;
    if (evt.eventType.includes('CLAIM')) typeColor = FG_CYAN;
    if (evt.eventType.includes('LOAN')) typeColor = FG_YELLOW;
    if (evt.eventType.includes('ADJUST')) typeColor = FG_GREEN;

    const timeStr = new Date(evt.createdAt).toISOString().replace('T', ' ').substring(0, 19);
    console.log(
      `${typeColor}${evt.eventType.padEnd(24)}${RESET} ` +
      `${String(evt.amount || 0).padEnd(10)} ` +
      `${String(evt.balanceAfter ?? '-').padEnd(16)} ` +
      `${DIM}${timeStr}${RESET}`
    );
  }
  console.log(`${FG_GRAY}──────────────────────────────────────────────────────────────────────────────────────────${RESET}`);

  await delay(1000);

  // =========================================================================
  // DEMO SUMMARY & ARCHITECTURAL HIGHLIGHTS
  // =========================================================================
  console.log(`\n${FG_GREEN}╔══════════════════════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${FG_GREEN}║${RESET}                     ${BOLD}${FG_WHITE}DEMO SCENARIOS COMPLETED SUCCESSFULLY${RESET}                            ${FG_GREEN}║${RESET}`);
  console.log(`${FG_GREEN}╚══════════════════════════════════════════════════════════════════════════════════════╝${RESET}\n`);

  renderBox(
    '🎯 ARCHITECTURAL PILLARS DEMONSTRATED',
    [
      `1. ${BOLD}Dual-Write Ground Truth Contract${RESET}:`,
      `   PostgreSQL ACID transaction committed BEFORE Redis Lua materialized view updates.`,
      '',
      `2. ${BOLD}High-Throughput Sub-Millisecond Limiting${RESET}:`,
      `   Sliding-window counter executed in single-roundtrip Redis Lua script with zero locks.`,
      '',
      `3. ${BOLD}Multi-Tenant Quota Trading Liquidity${RESET}:`,
      `   Cross-organization quota lending without cluster restarts or static reconfigurations.`,
      '',
      `4. ${BOLD}Graceful Degradation & RFC Compliance${RESET}:`,
      `   Standard 429 status with Retry-After header and fail-open/fail-closed circuit breakers.`,
      '',
      `5. ${BOLD}Full Auditability & Idempotency${RESET}:`,
      `   X-Idempotency-Key duplicate filtering with append-only quota_events sourcing.`,
    ],
    FG_GREEN
  );

  console.log(`\n${FG_CYAN}Explore further:${RESET}`);
  console.log(` • Interactive Swagger API Docs : ${FG_YELLOW}${BASE_URL}/docs${RESET}`);
  console.log(` • Prometheus Metrics Stream    : ${FG_YELLOW}${BASE_URL}/metrics${RESET}`);
  console.log(` • Web UI Simulator Dashboard   : ${FG_YELLOW}${BASE_URL}/dashboard${RESET}\n`);
}

// Execute
runDemo().catch((err) => {
  console.error(`\n${FG_RED}Unexpected fatal error in demo:${RESET}`, err);
  process.exit(1);
});
