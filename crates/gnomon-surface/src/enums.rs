//! gnomon-enums: print the enumerations contract as JSON.
//!
//! Usage:
//!   gnomon-enums [--json]
//!
//! Output conforms to conformance/enumerations_schema.json.

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
        assert_eq!(obj.len(), 6);
        assert!(obj.contains_key("edit_format"));
        assert!(obj.contains_key("sandbox"));
        assert!(obj.contains_key("approval"));
        assert!(obj.contains_key("role_profile"));
        assert!(obj.contains_key("governance_level"));
        assert!(obj.contains_key("governance_family"));
    }
}
