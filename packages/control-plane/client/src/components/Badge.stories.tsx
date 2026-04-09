import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, type BadgeVariant } from "./Badge";

const meta = {
  args: {
    variant: "running",
  },
  component: Badge,
  tags: ["autodocs"],
  title: "Components/Badge",
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

const variants: BadgeVariant[] = [
  "running",
  "retry",
  "failed",
  "idle",
  "completed",
  "degraded",
];

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      {variants.map((variant) => (
        <Badge key={variant} variant={variant} />
      ))}
    </div>
  ),
};

export const Running: Story = {
  args: {
    variant: "running",
  },
};
