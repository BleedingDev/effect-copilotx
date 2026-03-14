import { defineConfig } from "@rslib/core";
import { pluginTypeCheck } from "@rsbuild/plugin-type-check";
import { pluginPublint } from "rsbuild-plugin-publint";

export default defineConfig({
  lib: [
    {
      bundle: false,
      dts: {
        abortOnError: true,
      },
      format: "esm",
      syntax: "es2022",
    },
  ],
  output: {
    distPath: {
      root: "dist",
    },
    externals: [/^effect($|\/)/, /^@effect\//, /^drizzle-orm($|\/)/, /^pg$/],
    target: "node",
  },
  plugins: [pluginTypeCheck(), pluginPublint()],
  source: {
    entry: {
      index: [
        "./src/**/*.ts",
        "!./src/**/*.test.ts",
        "!./src/**/*.spec.ts",
        "!./src/**/__fixtures__/**",
      ],
    },
    tsconfigPath: "./tsconfig.json",
  },
});
