/**
 * The dashboard API and chaos drills are demo features: they seed admin orgs with well-known keys
 * and mutate quota without authentication. They are on outside production, or when DASHBOARD_DEMO=true
 * is set explicitly for a private deployment.
 */
export const demoEnabled = (): boolean =>
  process.env.NODE_ENV !== 'production' || process.env.DASHBOARD_DEMO === 'true';
