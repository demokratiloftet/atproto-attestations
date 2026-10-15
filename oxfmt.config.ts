import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    ".runtime/**",
    "data/**",
    "vendor/**",
    "deploy/pilot/gateway.patch",
  ],
});
