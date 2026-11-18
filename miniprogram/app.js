const api = require('./utils/api');

App({
  onLaunch() {
    // Sign in early so the first page opens faster; pages call ensureLogin again anyway.
    api.ensureLogin().catch(() => {});
  },
});
