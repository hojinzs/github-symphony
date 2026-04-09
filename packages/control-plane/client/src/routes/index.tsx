import { createFileRoute } from "@tanstack/react-router";

function HomeRoute() {
  return (
    <main>
      <h1>GitHub Symphony Control Plane</h1>
      <p>Control plane client scaffold.</p>
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: HomeRoute,
});
