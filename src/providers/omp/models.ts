import { OmpCli, type OmpCliModel } from "../../omp/cli";
import type { BackendCredentials, OpenCodeProvidersResponse } from "../types";
import { rememberModelWindows } from "./context";
import { mapRpcModelsToOpenCodeProviders, type OmpRpcModel } from "./rpc";

/** `omp models --json` carries the supported thinking levels as a list; the catalog mapper reads `thinking.efforts`. */
function toCatalogModel(model: OmpCliModel): OmpRpcModel {
  const { thinking, ...rest } = model;
  return { ...rest, name: model.name, ...(Array.isArray(thinking) ? { thinking: { efforts: thinking } } : {}) };
}

/**
 * The provider catalog for `cwd`. A caller with its own credentials gets a catalog read against
 * them alone; otherwise omp's configured models, with its `modelRoles.default` model first.
 */
export async function listOmpModels(cwd: string, credential?: BackendCredentials): Promise<OpenCodeProvidersResponse> {
  const { models, defaultModel } = await OmpCli.models({ cwd, credential });
  const providers = mapRpcModelsToOpenCodeProviders(models.map(toCatalogModel), defaultModel?.providerID, defaultModel?.modelID);
  rememberModelWindows(providers);
  return providers;
}
