import Card from "../components/ui/Card";

export default function PluginsSkills() {
  return (
    <div className="animate-fade-up space-y-6 md:space-y-8">
      <div>
        <h1 className="t-display">Skills</h1>
        <p className="t-body text-muted-fg mt-3 max-w-xl">
          Manage Agent Skills — reusable instruction modules that extend the agent&apos;s capabilities.
          Skills use the standard SKILL.md format, compatible with pi and community skill packs.
        </p>
      </div>
      <div className="rule-heavy" />
      <Card className="text-center py-16 halftone-light">
        <p className="t-body text-muted-fg">Coming soon — skill browser and installation.</p>
      </Card>
    </div>
  );
}
