use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::Client as DynamoClient;


/// Construct a DynamoDB client using the default AWS SDK configuration for this Lambda.
pub async fn dynamo_client() -> DynamoClient {
    let config = aws_config::defaults(BehaviorVersion::latest()).load().await;
    DynamoClient::new(&config)
}

/// Read the STAGE environment variable, panicking with a clear message if missing.
pub fn stage() -> String {
    std::env::var("STAGE").expect("STAGE env var must be set")
}

/// Names of the DynamoDB tables used by this application for the current stage.
#[derive(Clone, Debug)]
pub struct TableNames {
    pub notes: String,
    pub users: String,
    pub sessions: String,
}

impl TableNames {
    /// Resolve table names for the current stage (from the STAGE env var).
    pub fn load() -> Self {
        let stage = stage();
        Self {
            notes: format!("mini-notes-notes-{stage}"),
            users: format!("mini-notes-users-{stage}"),
            sessions: format!("mini-notes-sessions-{stage}"),
        }
    }
}
