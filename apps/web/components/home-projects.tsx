// "Projects at a glance" (compact, 1/3 column). While no project board is connected it is a short notice (the board
// arrives with the Projects task); nothing is invented.
import { PageSection } from "@nichols/ui";

export function ProjectsGlance() {
  return (
    <PageSection title="Projects at a glance" className="h-full" >
      <p data-testid="projects-notice" className="text-small text-muted-foreground">
        No project board connected. Status appears here, read-only, once the board is connected.
      </p>
    </PageSection>
  );
}
