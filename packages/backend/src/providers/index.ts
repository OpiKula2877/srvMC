import type { ServerType } from '@srvmc/shared';
import { arclight } from './arclight.ts';
import { fabric } from './fabric.ts';
import { forge, neoforge } from './forge.ts';
import { paper } from './paper.ts';
import { purpur } from './purpur.ts';
import { quilt } from './quilt.ts';
import { spigot } from './spigot.ts';
import type { Provider } from './types.ts';
import { vanilla } from './vanilla.ts';

export const providers: Partial<Record<ServerType, Provider>> = {
  vanilla,
  paper,
  purpur,
  spigot,
  fabric,
  quilt,
  forge,
  neoforge,
  arclight,
};

export function providerFor(type: ServerType): Provider | undefined {
  return providers[type];
}

export type { InstallContext, InstallPlan, PlannedFile, Provider } from './types.ts';
export { compareVersions, UserError } from './types.ts';
