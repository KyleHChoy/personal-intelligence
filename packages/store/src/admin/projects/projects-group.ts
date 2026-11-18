import type { AdminContext } from "../../core/admin-context.ts";
import { bound } from "../admin-bound.ts";
import * as areas from "./admin-areas.ts";
import { ownerProjects } from "./admin-project-board.ts";
import * as projects from "./admin-projects.ts";

// The owner's area commands (admin-areas.ts), as `Admin.areas`. Each refusal is an AdminError.
export const areasAdmin = (context: AdminContext) =>
  bound(context, {
    add: areas.add,
    rename: areas.rename,
    order: areas.order,
    retire: areas.retire,
    list: areas.list,
    setDefault: areas.setDefault,
    setProjectArea: areas.setProjectArea,
  });

// The owner's project commands (admin-projects.ts), as `Admin.projects`. Each refusal is an
// AdminError; anchor and unanchor throw "extract_running" while a run holds the extract lock.
export const projectsAdmin = (context: AdminContext) =>
  bound(context, {
    add: projects.add,
    anchor: projects.anchor,
    unanchor: projects.unanchor,
    close: projects.close,
    list: projects.list,
    // The dashboard's Projects room: every project with where it stands, its open work and what
    // changed in the last seven days (admin-project-board.ts).
    overview: ownerProjects,
  });
