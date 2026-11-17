import type { Config } from "tailwindcss";

// Sunset palette: coral clay, sea green, olive on warm cream. Plus Jakarta Sans everywhere
// (wired as --font-sunset in src/app/layout.tsx). Component styles: src/app/*.css.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        cream: "#FFF8F1",
        sand: "#FBEEE2",
        paper: "#FFFFFF",
        ink: {
          DEFAULT: "#26181B",
          soft: "#4A3438",
          muted: "#7A6467",
        },
        clay: {
          DEFAULT: "#FF6B4A",
          deep: "#C8401F",
          light: "#FF8E5E",
        },
        olive: {
          DEFAULT: "#5F7A3C",
          light: "#8AA060",
        },
        sea: {
          DEFAULT: "#1F6F78",
          deep: "#155259",
          light: "#4FA2A6",
        },
        gold: "#FFC38A",
        line: "#F2E3D6",
        // Money semantics: income / positive = olive, spent = coral (text-safe deep step), negative = rose.
        accent: {
          green: "#4F6B2E",
          "green-light": "#8AA060",
          purple: "#1F6F78",
          cyan: "#1F6F78",
          red: "#B5344F",
          orange: "#C8401F",
        },
      },
      fontFamily: {
        display: ["var(--font-sunset)", "system-ui", "sans-serif"],
        sans: ["var(--font-sunset)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        soft: "0 20px 40px -30px rgba(80,30,20,0.4)",
        lift: "0 30px 50px -30px rgba(255,107,74,0.55)",
      },
      borderRadius: {
        xl2: "20px",
      },
    },
  },
  plugins: [],
};

export default config;
