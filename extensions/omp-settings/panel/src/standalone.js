// Standalone page entry, served by the sidecar at /api/omp/settings/ui.js. The
// page defines window.__ompSettingsCall (plain fetch with the browser session).
import { mountSettings } from './view.js';

mountSettings({ call: window.__ompSettingsCall });
