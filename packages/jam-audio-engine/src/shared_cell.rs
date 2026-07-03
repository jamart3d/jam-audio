//! Thread-shared-mutability shim.
//!
//! In wasm32 we are strictly single-threaded; `Rc<RefCell<T>>` is sufficient
//! and `Send + Sync` is satisfied unsafely (see crate::Shared*MediaSource).
//! On native we use `Arc<Mutex<T>>`. Callers should never see the difference.

#[cfg(target_arch = "wasm32")]
mod imp {
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Debug)]
    pub struct SharedCell<T>(pub(crate) Rc<RefCell<T>>);

    impl<T> Clone for SharedCell<T> {
        fn clone(&self) -> Self {
            Self(Rc::clone(&self.0))
        }
    }

    impl<T> SharedCell<T> {
        pub fn new(value: T) -> Self {
            Self(Rc::new(RefCell::new(value)))
        }

        pub fn with<R>(&self, f: impl FnOnce(&T) -> R) -> R {
            f(&self.0.borrow())
        }

        pub fn with_mut<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
            f(&mut self.0.borrow_mut())
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use std::sync::{Arc, Mutex};

    #[derive(Debug)]
    pub struct SharedCell<T>(pub(crate) Arc<Mutex<T>>);

    impl<T> Clone for SharedCell<T> {
        fn clone(&self) -> Self {
            Self(Arc::clone(&self.0))
        }
    }

    impl<T> SharedCell<T> {
        pub fn new(value: T) -> Self {
            Self(Arc::new(Mutex::new(value)))
        }

        pub fn with<R>(&self, f: impl FnOnce(&T) -> R) -> R {
            let guard = self
                .0
                .lock()
                .expect("shared cell mutex poisoned");
            f(&guard)
        }

        pub fn with_mut<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
            let mut guard = self
                .0
                .lock()
                .expect("shared cell mutex poisoned");
            f(&mut guard)
        }
    }
}

pub use imp::SharedCell;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::SharedCell;
    use std::panic::{AssertUnwindSafe, catch_unwind};

    #[test]
    fn with_and_with_mut_panic_after_poisoned_mutex() {
        let cell = SharedCell::new(1usize);
        let poisoned = cell.clone();

        let result = catch_unwind(AssertUnwindSafe(|| {
            poisoned.with_mut(|value| {
                *value = 2;
                panic!("poison the mutex");
            });
        }));

        assert!(result.is_err());

        let result_with = catch_unwind(AssertUnwindSafe(|| {
            cell.with(|value| *value);
        }));
        assert!(result_with.is_err());

        let result_with_mut = catch_unwind(AssertUnwindSafe(|| {
            cell.with_mut(|value| {
                *value = 3;
            });
        }));
        assert!(result_with_mut.is_err());
    }

    #[test]
    fn new_wraps_initial_value() {
        let cell = SharedCell::new(42usize);
        assert_eq!(cell.with(|v| *v), 42);
    }

    #[test]
    fn with_provides_immutable_reference() {
        let cell = SharedCell::new(String::from("hello"));
        let len = cell.with(|s| s.len());
        assert_eq!(len, 5);
    }

    #[test]
    fn with_mut_modifies_inner_value() {
        let cell = SharedCell::new(0usize);
        cell.with_mut(|v| *v = 99);
        assert_eq!(cell.with(|v| *v), 99);
    }

    #[test]
    fn clone_shares_same_mutex() {
        let cell = SharedCell::new(0usize);
        let other = cell.clone();
        cell.with_mut(|v| *v = 7);
        assert_eq!(other.with(|v| *v), 7);
    }
}
