// Footprint = lista de paths/globs que uma task provavelmente vai tocar.
// Ex.: ["src/auth/*", "src/components/Login.tsx"]
export type Footprint = string[];

export interface LinearIssue {
  id: string;
  identifier: string; // ex.: ENG-123
  title: string;
  stateName: string;
  teamId?: string;
  blockedBy: string[]; // ids das issues que bloqueiam esta (Camada 1 de dependência)
}

export type WorkerMode = "implement" | "fix";
