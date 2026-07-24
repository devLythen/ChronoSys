#[cfg(test)]
mod tests {
    use chrono_config::*;
    use serde_json::json;

    fn setup() -> ConfigStore {
        ConfigStore::open_in_memory().unwrap()
    }

    #[test]
    fn migration_creates_tables() {
        let store = setup();
        store.providers().list_providers().unwrap();
        assert!(store.providers().get_credential("nope").is_err());
        assert!(store.providers().get_model("x", "y").is_err());
        store.accounts().list_accounts().unwrap();
        store.bots().list_bots().unwrap();
        store.bots().list_all_bindings().unwrap();
    }

    #[test]
    fn provider_crud() {
        let store = setup();
        let p = LlmProvider {
            id: "my-llm".into(),
            kind: "builtin".into(),
            base_url: None,
            display_name: "My LLM".into(),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.providers().insert_provider(&p).unwrap();

        let got = store.providers().get_provider("my-llm").unwrap();
        assert_eq!(got.id, "my-llm");
        assert!(got.enabled);

        let list = store.providers().list_enabled_providers().unwrap();
        assert_eq!(list.len(), 1);

        match store.providers().get_provider("nonexistent") {
            Err(ConfigError::NotFound { entity, .. }) => assert_eq!(entity, "llm_providers"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn model_upsert_and_overrides() {
        let store = setup();
        store.providers().insert_provider(&LlmProvider {
            id: "my-llm".into(),
            kind: "builtin".into(),
            base_url: None,
            display_name: "My LLM".into(),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();

        let m = LlmModel {
            provider_id: "my-llm".into(),
            model_id: "main-model".into(),
            display_name: Some("Main Model".into()),
            enabled: true,
            temperature: Some(0.7),
            max_tokens: Some(4096),
            top_p: None,
            extra_headers_json: None,
            extra_body_json: None,
            thinking_level: None,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.providers().upsert_model(&m).unwrap();

        let got = store.providers().get_model("my-llm", "main-model").unwrap();
        assert_eq!(got.temperature, Some(0.7));
        assert_eq!(got.max_tokens, Some(4096));

        let m2 = LlmModel {
            temperature: Some(0.3),
            extra_headers_json: Some(json!({"X-Custom": "v"})),
            ..m
        };
        store.providers().upsert_model(&m2).unwrap();
        let got = store.providers().get_model("my-llm", "main-model").unwrap();
        assert_eq!(got.temperature, Some(0.3));
        assert_eq!(got.extra_headers_json, Some(json!({"X-Custom": "v"})));
    }

    #[test]
    fn account_crud() {
        let store = setup();
        let a = PlatformAccount {
            id: "tg1".into(),
            platform: "telegram".into(),
            display_name: "Main TG".into(),
            adapter_id: "chrono.adapter.telegram".into(),
            enabled: true,
            secret_ref: "env:TG_TOKEN".into(),
            adapter_config_json: json!({"webhook": false}),
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.accounts().insert_account(&a).unwrap();
        let list = store.accounts().list_enabled_accounts().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].platform, "telegram");
    }

    #[test]
    fn bot_and_binding() {
        let store = setup();
        store.providers().insert_provider(&LlmProvider {
            id: "my-llm".into(),
            kind: "builtin".into(),
            base_url: None,
            display_name: "My LLM".into(),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();
        store.providers().upsert_model(&LlmModel {
            provider_id: "my-llm".into(),
            model_id: "main-model".into(),
            display_name: None,
            enabled: true,
            temperature: None,
            max_tokens: None,
            top_p: None,
            extra_headers_json: None,
            extra_body_json: None,
            thinking_level: None,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();
        store.accounts().insert_account(&PlatformAccount {
            id: "tg1".into(),
            platform: "telegram".into(),
            display_name: "TG".into(),
            adapter_id: "chrono.adapter.telegram".into(),
            enabled: true,
            secret_ref: "env:TG_TOKEN".into(),
            adapter_config_json: json!({}),
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();

        let bot = BotProfile {
            id: "greeter".into(),
            display_name: "Greeter".into(),
            system_prompt: "Be friendly.".into(),
            model_ref: "my-llm/main-model".into(),
            tools_allowlist_json: json!(["message_send"]),
            skills_allowlist_json: json!([]),
            policy_json: json!({}),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.bots().insert_bot(&bot).unwrap();

        let binding = Binding {
            id: "b1".into(),
            account_id: "tg1".into(),
            chat_pattern: "dm:*".into(),
            bot_profile_id: "greeter".into(),
            session_mode: "dm".into(),
            priority: 10,
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.bots().insert_binding(&binding).unwrap();

        let bindings = store.bots().list_bindings_for_account("tg1").unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].bot_profile_id, "greeter");

        let got = store.bots().get_bot("greeter").unwrap();
        assert_eq!(got.model_ref, "my-llm/main-model");
    }

    #[test]
    fn bot_without_model_ref_fails_later() {
        let store = setup();
        let bot = BotProfile {
            id: "orphan".into(),
            display_name: "Orphan".into(),
            system_prompt: ".".into(),
            model_ref: "nonexistent/gpt-99".into(),
            tools_allowlist_json: json!([]),
            skills_allowlist_json: json!([]),
            policy_json: json!({}),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.bots().insert_bot(&bot).unwrap();
        assert!(store.providers().get_model("nonexistent", "gpt-99").is_err());
    }

    #[test]
    fn custom_provider_with_base_url() {
        let store = setup();
        let p = LlmProvider {
            id: "my-proxy".into(),
            kind: "openai_compat".into(),
            base_url: Some("https://proxy.example.com/v1".into()),
            display_name: "My Proxy".into(),
            enabled: true,
            json_ext: json!({"default_headers": {"X-Region": "us"}}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.providers().insert_provider(&p).unwrap();

        let got = store.providers().get_provider("my-proxy").unwrap();
        assert_eq!(got.kind, "openai_compat");
        assert_eq!(got.base_url.as_deref(), Some("https://proxy.example.com/v1"));
        assert_eq!(got.json_ext["default_headers"]["X-Region"], "us");
    }

    #[test]
    fn delete_account_bot_provider() {
        let store = setup();
        store.providers().insert_provider(&LlmProvider {
            id: "p1".into(),
            kind: "builtin".into(),
            base_url: None,
            display_name: "P".into(),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();
        store.providers().upsert_credential(&LlmCredential {
            provider_id: "p1".into(),
            auth_kind: "api_key".into(),
            secret_ref: "env:KEY".into(),
            json_ext: json!({}),
            updated_at: String::new(),
        }).unwrap();
        store.providers().upsert_model(&LlmModel {
            provider_id: "p1".into(),
            model_id: "m1".into(),
            display_name: None,
            enabled: true,
            temperature: None,
            max_tokens: None,
            top_p: None,
            extra_headers_json: None,
            extra_body_json: None,
            thinking_level: None,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();
        store.accounts().insert_account(&PlatformAccount {
            id: "a1".into(),
            platform: "telegram".into(),
            display_name: "A".into(),
            adapter_id: "chrono.adapter.telegram".into(),
            enabled: true,
            secret_ref: "env:TG".into(),
            adapter_config_json: json!({}),
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();
        store.bots().insert_bot(&BotProfile {
            id: "b1".into(),
            display_name: "B".into(),
            system_prompt: "".into(),
            model_ref: "p1/m1".into(),
            tools_allowlist_json: json!([]),
            skills_allowlist_json: json!([]),
            policy_json: json!({}),
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();
        store.bots().insert_binding(&Binding {
            id: "bind1".into(),
            account_id: "a1".into(),
            chat_pattern: "*".into(),
            bot_profile_id: "b1".into(),
            session_mode: "shared".into(),
            priority: 0,
            enabled: true,
            json_ext: json!({}),
            created_at: String::new(),
            updated_at: String::new(),
        }).unwrap();

        store.bots().delete_bot("b1").unwrap();
        assert!(store.bots().get_bot("b1").is_err());
        // binding cascaded via FK
        assert!(store.bots().get_binding("bind1").is_err());

        store.accounts().delete_account("a1").unwrap();
        assert!(store.accounts().get_account("a1").is_err());

        store.providers().delete_credential("p1").unwrap();
        assert!(store.providers().get_credential("p1").is_err());

        store.providers().delete_provider("p1").unwrap();
        assert!(store.providers().get_provider("p1").is_err());
        // models cascaded
        assert!(store.providers().get_model("p1", "m1").is_err());

        match store.accounts().delete_account("missing") {
            Err(ConfigError::NotFound { .. }) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn settings_crud() {
        let store = setup();
        store.settings().set("feature.x", &json!(true)).unwrap();
        store.settings().set("feature.y", &json!({"n": 1})).unwrap();

        let got = store.settings().get("feature.x").unwrap().unwrap();
        assert_eq!(got.key, "feature.x");
        assert_eq!(got.value_json, json!(true));

        let list = store.settings().list().unwrap();
        assert_eq!(list.len(), 2);

        store.settings().set("feature.x", &json!(false)).unwrap();
        let got = store.settings().get("feature.x").unwrap().unwrap();
        assert_eq!(got.value_json, json!(false));

        store.settings().delete("feature.y").unwrap();
        assert!(store.settings().get("feature.y").unwrap().is_none());
        match store.settings().delete("nope") {
            Err(ConfigError::NotFound { .. }) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
