import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const meta = {
  component: Button,
  tags: ["autodocs"],
  title: "Components/Button",
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>Refresh</Button>
      <Button size="sm">Refresh</Button>
      <Button variant="ghost">Details</Button>
      <Button variant="ghost" size="sm">
        Details
      </Button>
      <Button variant="destructive">Cancel</Button>
      <Button variant="destructive" size="sm">
        Cancel
      </Button>
    </div>
  ),
};

export const AsLink: Story = {
  render: () => (
    <Button asChild variant="ghost">
      <a href="/issues/demo">Issue Details</a>
    </Button>
  ),
};

export const DisabledLink: Story = {
  render: () => (
    <Button asChild disabled variant="ghost">
      <a href="/issues/demo">Issue Details</a>
    </Button>
  ),
};
