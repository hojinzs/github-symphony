import type { Meta, StoryObj } from "@storybook/react-vite";
import { FoundationsPage } from "./FoundationsPage";

const meta = {
  component: FoundationsPage,
  tags: ["autodocs"],
  title: "Pages/Foundations",
} satisfies Meta<typeof FoundationsPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
