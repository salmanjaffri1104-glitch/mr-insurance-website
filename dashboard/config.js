// Mr Insurance Dashboard — frontend settings
// ---------------------------------------------------------------------------
// STEP 2 of the deploy guide: after `wrangler deploy`, paste the Worker URL
// it prints (https://mr-insurance-dashboard-api.<your-name>.workers.dev)
// between the quotes below. Nothing else in this file needs to change.
//
// SECURITY: there is NO password in this file. The password is typed by the
// owner on the login screen, checked once by the Worker, and kept only in
// this browser tab's session memory (sessionStorage). Closing the tab logs out.
window.APP_CONFIG = {
  API_BASE: "https://mr-insurance-dashboard-api.mrinsurance.workers.dev"
};
