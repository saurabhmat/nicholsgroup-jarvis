// T-230 A review: the onboarding page runs the lane gate and the owner's brain view together. A refused lane always wins,
// and anything but "the owner with the brain view" (null, a failed lookup) is the same 404.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
const loadLane = vi.fn();
const onboardingFor = vi.fn();
vi.mock("@/lib/lane-page", () => ({ loadLane: (...a: unknown[]) => loadLane(...a) }));
vi.mock("@/lib/onboarding-progress", () => ({ onboardingFor: (...a: unknown[]) => onboardingFor(...a) }));
vi.mock("@/components/brain-interview", () => ({ BrainInterview: () => null }));
vi.mock("@/lib/onboarding", () => ({ sectionIdFrom: () => null }));

const { OnboardingPage } = await import("@/components/onboarding-page");
const props = { params: Promise.resolve({ laneId: "PKG" }), searchParams: Promise.resolve({}) };

beforeEach(() => {
  loadLane.mockReset().mockResolvedValue({ laneId: "PKG", name: "Pub K Group", lanes: [] });
  onboardingFor.mockReset();
});

describe("OnboardingPage", () => {
  it("a refused lane is the lane's 404 even when the setup lookup fails", async () => {
    loadLane.mockRejectedValue(new Error("NOT_FOUND"));
    onboardingFor.mockRejectedValue(new Error("setup lookup failed"));
    await expect(OnboardingPage(props)).rejects.toThrow("NOT_FOUND");
  });

  it("a refused lane redirect also wins over a failed setup lookup", async () => {
    loadLane.mockRejectedValue(new Error("REDIRECT /sign-in"));
    onboardingFor.mockRejectedValue(new Error("boom"));
    await expect(OnboardingPage(props)).rejects.toThrow("REDIRECT /sign-in");
  });

  it("null (not the owner with the brain view) is a 404, never access", async () => {
    onboardingFor.mockResolvedValue(null);
    await expect(OnboardingPage(props)).rejects.toThrow("NOT_FOUND");
  });

  it("a failed setup lookup on an open lane is a 404 too, not a wizard", async () => {
    onboardingFor.mockRejectedValue(new Error("boom"));
    await expect(OnboardingPage(props)).rejects.toThrow("NOT_FOUND");
  });

  it("the owner with the brain view gets the page", async () => {
    onboardingFor.mockResolvedValue({ done: 0, total: 10, sections: [], nextSectionId: null });
    await expect(OnboardingPage(props)).resolves.toBeTruthy();
  });
});
