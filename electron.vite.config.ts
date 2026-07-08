import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@mioproxy/config-pipeline", "@mioproxy/core-runtime"]
      })
    ],
    build: {
      rollupOptions: {
        input: "src/main/main.ts"
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: "src/preload/preload.ts",
        output: {
          format: "cjs",
          entryFileNames: "preload.js"
        }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()]
  }
});
