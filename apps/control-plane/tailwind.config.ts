import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "../../packages/shared/src/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#0d141c",
        signal: "#ff6b35",
        mist: "#f4efe8",
        tide: "#8ecae6"
      },
      fontFamily: {
        display: ["Georgia", "serif"],
        body: ["Helvetica Neue", "Arial", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
