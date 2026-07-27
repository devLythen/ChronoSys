import { usePageEnter } from "../hooks/useAnimations";
import Card from "../components/ui/Card";

export default function PluginsMcp() {
  const pageRef = usePageEnter<HTMLDivElement>();
  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">MCP</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Connect to Model Context Protocol servers to extend the agent with external tools and data sources.
        </p>
      </div>
      <div className="rule-heavy" />
      <Card className="text-center py-16 halftone-light">
        <p className="t-body text-muted-fg">Coming soon — MCP server configuration and connection management.</p>
      </Card>
    </div>
  );
}
