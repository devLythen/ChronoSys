import { usePageEnter } from "../hooks/useAnimations";
import Card from "../components/ui/Card";

export default function PluginsExtensions() {
  const pageRef = usePageEnter<HTMLDivElement>();
  return (
    <div ref={pageRef} className="space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">Extensions</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Install and manage tool extensions from the community or build your own.
        </p>
      </div>
      <div className="rule-heavy" />
      <Card className="text-center py-16 halftone-light">
        <p className="t-body text-muted-fg">Coming soon — plugin marketplace and extension management.</p>
      </Card>
    </div>
  );
}
