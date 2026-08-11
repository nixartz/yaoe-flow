import { describe, expect, test } from "bun:test";
import {
  collapseGlobToPath,
  footprintsCollide,
  isWithinFootprint,
  toGlobPattern,
} from "../src/dag";
import { filesOutsideFootprint } from "../src/scope";

describe("toGlobPattern dialect", () => {
  test("trailing /* becomes recursive /**", () => {
    expect(toGlobPattern("src/auth/*")).toBe("src/auth/**");
    expect(toGlobPattern("src/store/*")).toBe("src/store/**");
  });

  test("trailing /** and mid-path ** stay intact", () => {
    expect(toGlobPattern("src/auth/**")).toBe("src/auth/**");
    expect(toGlobPattern("src/app/**/perfil/**")).toBe("src/app/**/perfil/**");
  });
});

describe("isWithinFootprint globstar", () => {
  test("INF-23: **/perfil/** matches direct and nested perfil paths", () => {
    expect(isWithinFootprint("src/app/perfil/page.tsx", "src/app/**/perfil/**")).toBe(true);
    expect(isWithinFootprint("src/app/(app)/perfil/page.tsx", "src/app/**/perfil/**")).toBe(true);
    expect(
      isWithinFootprint("src/components/perfil/AppearanceSection.tsx", "src/components/**/perfil/**")
    ).toBe(true);
    expect(
      isWithinFootprint("src/components/settings/perfil/Screen.tsx", "src/components/**/perfil/**")
    ).toBe(true);
  });

  test("trailing /* covers the whole subtree (SOUL <module>/* dialect)", () => {
    expect(isWithinFootprint("src/auth/login.ts", "src/auth/*")).toBe(true);
    expect(isWithinFootprint("src/auth/deep/nested.ts", "src/auth/*")).toBe(true);
    expect(isWithinFootprint("src/auth", "src/auth/*")).toBe(true);
    expect(isWithinFootprint("src/billing/x.ts", "src/auth/*")).toBe(false);
  });

  test("exact file and repo-wide", () => {
    expect(isWithinFootprint("src/components/Providers.tsx", "src/components/Providers.tsx")).toBe(
      true
    );
    expect(isWithinFootprint("anything/here.ts", "*")).toBe(true);
  });

  test("mid-path single * is one segment only", () => {
    expect(isWithinFootprint("src/a/b/c.ts", "src/*/b/c.ts")).toBe(true);
    expect(isWithinFootprint("src/a/x/b/c.ts", "src/*/b/c.ts")).toBe(false);
  });
});

describe("filesOutsideFootprint with globstar footprint", () => {
  test("INF-23 footprint accepts perfil feature files", () => {
    const footprint = [
      "infleux-brands-app:src/app/**/perfil/**",
      "infleux-brands-app:src/components/**/perfil/**",
      "infleux-brands-app:src/components/Providers.tsx",
      "infleux-brands-app:src/store/*",
      "infleux-brands-app:src/i18n/namespaces.ts",
      "infleux-brands-app:messages/pt-BR/settings.json",
    ];
    const outside = filesOutsideFootprint(
      [
        "src/app/perfil/page.tsx",
        "src/components/perfil/AppearanceSection.tsx",
        "src/components/Providers.tsx",
        "src/store/themeStore.ts",
        "CHANGELOG.md",
        "knowledge/changes/2026-08-10/perfil-settings/README.md",
        "src/lib/api-client.ts",
      ],
      footprint,
      "infleux-brands-app"
    );
    expect(outside).toEqual(["src/lib/api-client.ts"]);
  });
});

describe("footprintsCollide with globstar", () => {
  test("same perfil globstar entries collide", () => {
    expect(
      footprintsCollide(
        ["app:src/app/**/perfil/**"],
        ["app:src/app/perfil/*"]
      )
    ).toBe(true);
  });

  test("perfil vs Providers under components do not false-collide", () => {
    expect(
      footprintsCollide(
        ["app:src/components/**/perfil/**"],
        ["app:src/components/Providers.tsx"]
      )
    ).toBe(false);
  });

  test("different module trees do not collide", () => {
    expect(
      footprintsCollide(["app:src/app/**/perfil/**"], ["app:src/components/**/perfil/**"])
    ).toBe(false);
    expect(footprintsCollide(["app:src/auth/*"], ["app:src/billing/*"])).toBe(false);
  });

  test("collapse helper produces witness paths", () => {
    expect(collapseGlobToPath("src/app/**/perfil/**")).toBe("src/app/perfil");
    expect(collapseGlobToPath("src/auth/*")).toBe("src/auth");
  });

  test("two mid-globstar patterns with different literal next-segment do not false-collide", () => {
    // Same literal prefix (src/app), both followed by **/<literal>/** — no real
    // path segment can equal both "perfil" and "billing" at once.
    expect(
      footprintsCollide(["app:src/app/**/perfil/**"], ["app:src/app/**/billing/**"])
    ).toBe(false);
    expect(
      footprintsCollide(["app:src/app/**/perfil/**"], ["app:src/app/**/perfil-extra/**"])
    ).toBe(false);
  });

  test("a bare trailing ** still conservatively collides with a deeper globstar under it", () => {
    // src/app/** alone matches everything under src/app, including .../perfil/... —
    // the "next segment" is ambiguous (it IS the globstar), so stay conservative.
    expect(footprintsCollide(["app:src/app/**"], ["app:src/app/**/perfil/**"])).toBe(true);
  });

  test("still conservative when literal prefixes only nest (not exactly equal)", () => {
    // prefix "src/app" vs "src/app/legacy" — not the same globstar boundary,
    // no provable disjointness, stays conservative.
    expect(
      footprintsCollide(["app:src/app/**/perfil/**"], ["app:src/app/legacy/**/billing/**"])
    ).toBe(true);
  });
});
