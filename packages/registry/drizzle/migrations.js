import m0000 from "./0000_init.sql";
import m0001 from "./0001_repository_installation.sql";
import m0002 from "./0002_scan_requests.sql";
import m0003 from "./0003_scan_force.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
	},
};
