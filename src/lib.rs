pub mod activity;
pub mod application;
pub mod clock;
pub mod diagnostics;
pub mod model;
mod read_pool;
pub mod server;
pub mod store;
pub mod supervisor;
pub mod view;
pub mod web;
mod web_assets;
pub mod web_auth;

pub mod projection;

pub mod recurrence_model;

pub mod planning;
mod priority_grid;
pub mod priority_policy;

pub mod task_planning;

pub mod mcp_contract;

pub mod output_schema;

#[cfg(feature = "postgres-storage")]
pub mod postgres;

#[cfg(feature = "postgres-storage")]
pub mod identity;

mod search_engine;
