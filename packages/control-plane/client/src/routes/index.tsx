import { createRoute, createFileRoute } from "@tanstack/react-router";
import { FoundationsPage } from "../pages/FoundationsPage";
import { Route as RootRoute } from "./__root";

function HomeRoute() {
  return <FoundationsPage />;
}

export const Route = createRoute("/")({
  getParentRoute: () => RootRoute,
  path: "/",
  component: HomeRoute,
});
