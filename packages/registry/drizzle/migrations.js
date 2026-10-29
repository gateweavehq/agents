import m0000 from "./0000_init.sql";
import m0001 from "./0001_repository_installation.sql";
import m0002 from "./0002_scan_requests.sql";
import m0003 from "./0003_scan_force.sql";
import m0004 from "./0004_library_keys.sql";
import m0005 from "./0005_setups.sql";
import m0006 from "./0006_setup_applications.sql";
import m0007 from "./0007_repository_files.sql";
import m0008 from "./0008_rescan_for_drift.sql";
import m0009 from "./0009_provider_keys.sql";
import m0010 from "./0010_agent_definitions.sql";
import m0011 from "./0011_environment_sets.sql";
import m0012 from "./0012_conversations.sql";
import m0013 from "./0013_runs.sql";
import m0014 from "./0014_agent_mcp_servers.sql";
import m0015 from "./0015_mcp_checks.sql";
import m0016 from "./0016_teams.sql";
import m0017 from "./0017_team_turns.sql";
import m0018 from "./0018_triggers.sql";
import m0019 from "./0019_mcp_tool_allowlist.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
		m0004,
		m0005,
		m0006,
		m0007,
		m0008,
		m0009,
		m0010,
		m0011,
		m0012,
		m0013,
		m0014,
		m0015,
		m0016,
		m0017,
		m0018,
		m0019,
	},
};
