import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { FoundationsPage } from "./pages/FoundationsPage";
import "./index.css";

function App() {
  return (
    <Theme appearance="dark" accentColor="blue" grayColor="gray" radius="medium">
      <FoundationsPage />
    </Theme>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
