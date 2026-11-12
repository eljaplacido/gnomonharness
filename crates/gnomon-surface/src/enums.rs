//! gnomon-enums: print the enumerations contract as JSON.
//!
//! Usage:
//!   gnomon-enums [--json]
//!
//! Output conforms to conformance/enumerations_schema.json. The TypeScript
//! constants each list mirrors (AUDIT_KINDS, GUARD_DECISIONS, GUARD_RULES,
//! GUARD_TOOLS) are held to conformance/enumerations_golden.json by
//! packages/gnomon-core/src/guard.test.ts.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Enumerations {
    pub edit_format: Vec<String>,
    pub sandbox: Vec<String>,
    pub approval: Vec<String>,
    pub role_profile: Vec<String>,
    /// `[governance]` levels, weakest first (docs/CONTRACTS.md §36).
    pub governance_level: Vec<String>,
    /// The families every policy rule is assigned to (docs/CONTRACTS.md §36).
    pub governance_family: Vec<String>,
    /// Every audit record `kind` a trail may hold (docs/CONTRACTS.md §41; #113).
    pub audit_kind: Vec<String>,
    /// `gnomon guard` decisions (docs/CONTRACTS.md §10).
    pub guard_decision: Vec<String>,
    /// `gnomon guard` rules (docs/CONTRACTS.md §10).
    pub guard_rule: Vec<String>,
    /// The tool kinds `gnomon guard` decides a call as (docs/CONTRACTS.md §10).
    pub guard_tool: Vec<String>,
}

impl Enumerations {
    pub fn new() -> Self {
        Self {
            edit_format: vec!["ast".into(), "hashline".into(), "str_replace".into()],
            sandbox: vec!["off".into(), "confined".into(), "strict".into()],
            approval: vec!["never".into(), "on_write".into(), "always".into()],
            role_profile: vec!["local_first".into(), "frontier_plan".into(), "all_remote".into()],
            governance_level: vec!["observe".into(), "advise".into(), "prevent".into(), "enforce".into()],
            governance_family: vec![
                "write".into(),
                "bash".into(),
                "network".into(),
                "secrets".into(),
                "rules".into(),
                "ci".into(),
            ],
            audit_kind: vec![
                "session_start".into(),
                "session_resume".into(),
                "turn".into(),
                "chain_stage".into(),
                "tool_call".into(),
                "approval".into(),
                "verify".into(),
                "bootstrap".into(),
                "context_mask".into(),
                "degradation".into(),
                "check".into(),
                "trust".into(),
                "guard".into(),
                "skill_accept".into(),
                "skill_reject".into(),
                "skill_trial".into(),
                "record_tamper".into(),
                "record_tamper_resolved".into(),
                "record_notice".into(),
                "mcp_tools".into(),
                "stall_signal".into(),
                "completion_gate".into(),
                "todo_gate".into(),
                "job".into(),
                "deliverable_first".into(),
                "first_token_stall".into(),
                "finish_gate".into(),
                "model_call".into(),
                "session_end".into(),
            ],
            guard_decision: vec!["allow".into(), "deny".into(), "ask".into()],
            guard_rule: vec![
                "tools".into(),
                "malformed".into(),
                "bash_deny".into(),
                "bash_allow".into(),
                "sudo".into(),
                "sandbox".into(),
                "surface".into(),
                "record".into(),
                "git_hooks".into(),
                "host_hooks".into(),
                "write_allow".into(),
                "outside_root".into(),
                "secret_path".into(),
                "ci_path".into(),
                "network".into(),
                "url".into(),
                "repo_code".into(),
                "approval".into(),
                "ungoverned".into(),
                "error".into(),
            ],
            guard_tool: vec![
                "bash".into(),
                "write".into(),
                "edit".into(),
                "read".into(),
                "webfetch".into(),
                "grep".into(),
                "glob".into(),
                "execute".into(),
            ],
        }
    }
}

impl Default for Enumerations {
    fn default() -> Self {
        Self::new()
    }
}

fn main() {
    let enums = Enumerations::new();
    let json = serde_json::to_string_pretty(&enums).unwrap();
    println!("{}", json);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enums_json_output() {
        let enums = Enumerations::new();
        let json = serde_json::to_string_pretty(&enums).unwrap();

        // Must contain all required keys
        assert!(json.contains("edit_format"));
        assert!(json.contains("sandbox"));
        assert!(json.contains("approval"));
        assert!(json.contains("role_profile"));
        assert!(json.contains("governance_level"));
        assert!(json.contains("governance_family"));
        assert!(json.contains("audit_kind"));
        assert!(json.contains("guard_rule"));

        // Must be valid JSON
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = parsed.as_object().unwrap();

        // All arrays have exactly 3 items
        assert_eq!(obj.get("edit_format").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(obj.get("sandbox").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(obj.get("approval").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(obj.get("role_profile").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(obj.get("governance_level").unwrap().as_array().unwrap().len(), 4);
        assert_eq!(obj.get("governance_family").unwrap().as_array().unwrap().len(), 6);
        assert_eq!(obj.get("audit_kind").unwrap().as_array().unwrap().len(), 29);
        assert_eq!(obj.get("guard_decision").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(obj.get("guard_rule").unwrap().as_array().unwrap().len(), 20);
        assert_eq!(obj.get("guard_tool").unwrap().as_array().unwrap().len(), 8);
    }

    #[test]
    fn test_enums_serialization_roundtrip() {
        let enums = Enumerations::new();
        let json = serde_json::to_string(&enums).unwrap();
        let decoded: Enumerations = serde_json::from_str(&json).unwrap();

        assert_eq!(enums.edit_format, decoded.edit_format);
        assert_eq!(enums.sandbox, decoded.sandbox);
        assert_eq!(enums.approval, decoded.approval);
        assert_eq!(enums.role_profile, decoded.role_profile);
        assert_eq!(enums.governance_level, decoded.governance_level);
        assert_eq!(enums.governance_family, decoded.governance_family);
        assert_eq!(enums.audit_kind, decoded.audit_kind);
        assert_eq!(enums.guard_decision, decoded.guard_decision);
        assert_eq!(enums.guard_rule, decoded.guard_rule);
        assert_eq!(enums.guard_tool, decoded.guard_tool);
    }

    #[test]
    fn test_enums_values_match_contract() {
        let enums = Enumerations::new();

        // edit_format values
        assert_eq!(enums.edit_format, vec!["ast", "hashline", "str_replace"]);

        // sandbox values
        assert_eq!(enums.sandbox, vec!["off", "confined", "strict"]);

        // approval values
        assert_eq!(enums.approval, vec!["never", "on_write", "always"]);

        // role_profile values
        assert_eq!(enums.role_profile, vec!["local_first", "frontier_plan", "all_remote"]);

        // governance_level, weakest first; governance_family
        assert_eq!(enums.governance_level, vec!["observe", "advise", "prevent", "enforce"]);
        assert_eq!(enums.governance_family, vec!["write", "bash", "network", "secrets", "rules", "ci"]);
    }

    #[test]
    fn test_enums_minimal_output() {
        // Ensure output is valid for JSON Schema validation
        let enums = Enumerations::new();
        let json = serde_json::to_string_pretty(&enums).unwrap();

        // Should not have any extra keys
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj.len(), 10);
        assert!(obj.contains_key("edit_format"));
        assert!(obj.contains_key("sandbox"));
        assert!(obj.contains_key("approval"));
        assert!(obj.contains_key("role_profile"));
        assert!(obj.contains_key("governance_level"));
        assert!(obj.contains_key("governance_family"));
        for k in ["audit_kind", "guard_decision", "guard_rule", "guard_tool"] {
            assert!(obj.contains_key(k));
        }
    }
}
