import type { Preview } from "@storybook/react-vite";
import { Theme } from "@radix-ui/themes";
import "../src/index.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <Theme appearance="dark" accentColor="blue" grayColor="gray" radius="medium">
        <div className="min-h-screen bg-bg-default px-6 py-8 text-text-primary">
          <Story />
        </div>
      </Theme>
    ),
  ],
  parameters: {
    backgrounds: {
      disable: true,
    },
    controls: {
      expanded: true,
    },
    layout: "fullscreen",
  },
};

export default preview;
