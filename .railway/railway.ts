import { defineRailway, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "nightpos-app";
export default defineRailway(() => {
  const nightposApp = service("nightpos-app", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["www.zhaocaimao.work", "zhaocaimao.work"],
  });

  return project("nightpos", {
    variables: { managed: false },
    resources: [nightposApp],
  });
});
