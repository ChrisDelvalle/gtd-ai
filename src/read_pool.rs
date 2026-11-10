//! Bounded, exclusive SQLite connections for read operations. Search waits never
//! own the application's writer mutex. SQLite still serializes short writes made
//! by availability catch-up and frozen search-session persistence.
use crate::store::{Store, StoreError};
use std::{
    ops::{Deref, DerefMut},
    path::PathBuf,
    sync::{Condvar, Mutex},
};

pub(crate) struct ReadPool {
    path: PathBuf,
    origin: &'static str,
    identity: String,
    state: Mutex<State>,
    ready: Condvar,
}
struct State {
    idle: Vec<Store>,
    leased: usize,
}
pub(crate) struct Lease<'a> {
    pool: &'a ReadPool,
    store: Option<Store>,
}

impl ReadPool {
    pub fn new(store: &Store) -> Option<Self> {
        let (path, origin, identity) = store.read_source()?;
        Some(Self {
            path,
            origin,
            identity,
            state: Mutex::new(State {
                idle: vec![],
                leased: 0,
            }),
            ready: Condvar::new(),
        })
    }
    pub fn acquire(&self) -> Result<Lease<'_>, StoreError> {
        let unavailable = || StoreError::Invalid("Read connections unavailable".into());
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        while state.leased == 4 {
            state = self.ready.wait(state).map_err(|_| unavailable())?;
        }
        state.leased += 1;
        let existing = state.idle.pop();
        drop(state);
        let store = existing
            .map(Ok)
            .unwrap_or_else(|| Store::connect_read(&self.path, self.origin, &self.identity));
        match store {
            Ok(store) => Ok(Lease {
                pool: self,
                store: Some(store),
            }),
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    state.leased -= 1;
                    self.ready.notify_one();
                }
                Err(error)
            }
        }
    }
}
impl Deref for Lease<'_> {
    type Target = Store;
    fn deref(&self) -> &Store {
        self.store.as_ref().unwrap()
    }
}
impl DerefMut for Lease<'_> {
    fn deref_mut(&mut self) -> &mut Store {
        self.store.as_mut().unwrap()
    }
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.pool.state.lock() {
            state.idle.push(self.store.take().unwrap());
            state.leased -= 1;
            self.pool.ready.notify_one();
        }
    }
}
