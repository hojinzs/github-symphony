import { createFileRoute } from "@tanstack/react-router";
import { FoundationsPage } from "../pages/FoundationsPage";

function HomeRoute() {
  return <FoundationsPage />;
}

export const Route = createFileRoute("/")({
  component: HomeRoute,
});
