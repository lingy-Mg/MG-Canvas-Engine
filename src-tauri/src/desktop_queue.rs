use mg_canvas_desktop::desktop_control::{pipe, Failure};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::{
    sync::{oneshot, Notify},
    time::timeout,
};

#[derive(Serialize)]
pub struct Job {
    id: String,
    action: &'static str,
    args: Value,
}

type Reply = oneshot::Sender<Value>;

#[derive(Default)]
struct Work {
    queued: VecDeque<(Job, Reply)>,
    executing: Option<(String, Reply)>,
    completed: Option<String>,
    generation: u64,
}

#[derive(Default)]
pub struct Queue {
    next_id: AtomicU64,
    changed: Notify,
    work: Mutex<Work>,
}

impl Queue {
    pub async fn submit(&self, action: &'static str, args: Value, duration: Duration) -> Value {
        let (send, mut reply) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        {
            let mut work = self.work.lock().unwrap();
            if work.queued.len() >= pipe::CAPACITY {
                return Failure::new("BUSY", "The workbench already has pending requests").result();
            }
            work.queued.push_back((
                Job {
                    id: id.clone(),
                    action,
                    args,
                },
                send,
            ));
        }
        self.changed.notify_waiters();
        if let Ok(Ok(value)) = timeout(duration, &mut reply).await {
            return value;
        }

        let mut work = self.work.lock().unwrap();
        // Completion may have raced the timer. The mutex synchronizes this last check.
        if let Ok(value) = reply.try_recv() {
            return value;
        }
        if let Some(index) = work.queued.iter().position(|(job, _)| job.id == id) {
            work.queued.remove(index);
            return Failure::new(
                "NOT_READY",
                "The workbench did not accept the request before its deadline",
            )
            .result();
        }
        Failure::new(
            "UNKNOWN_OUTCOME",
            "The workbench received the request but has not confirmed the result",
        )
        .result()
    }

    pub async fn next(&self) -> Option<Job> {
        let generation = self.work.lock().unwrap().generation;
        timeout(Duration::from_secs(15), async {
            loop {
                let changed = self.changed.notified();
                {
                    let mut work = self.work.lock().unwrap();
                    if work.generation != generation {
                        return None;
                    }
                    if work.executing.is_none() {
                        if let Some((job, send)) = work.queued.pop_front() {
                            work.executing = Some((job.id.clone(), send));
                            return Some(job);
                        }
                    }
                }
                changed.await;
            }
        })
        .await
        .ok()
        .flatten()
    }

    pub fn complete(&self, id: &str, result: Value) -> Result<(), &'static str> {
        if !result.get("ok").is_some_and(Value::is_boolean) {
            return Err("Expected a result object with a boolean ok field");
        }
        {
            let mut work = self.work.lock().unwrap();
            if work.completed.as_deref() == Some(id) {
                return Ok(());
            }
            if work
                .executing
                .as_ref()
                .is_none_or(|(active, _)| active != id)
            {
                return Err("The command ID is not active");
            }
            let (_, send) = work.executing.take().unwrap();
            work.completed = Some(id.to_owned());
            let _ = send.send(result);
        }
        self.changed.notify_waiters();
        Ok(())
    }

    pub fn reset_page(&self) {
        {
            let mut work = self.work.lock().unwrap();
            work.generation += 1;
            work.completed = None;
            if let Some((_, send)) = work.executing.take() {
                let _ = send.send(
                    Failure::new(
                        "UNKNOWN_OUTCOME",
                        "The workbench reloaded while processing the request",
                    )
                    .result(),
                );
            }
        }
        self.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expired_queued_work_is_not_executed() {
        pipe::runtime().unwrap().block_on(async {
            let queue = Queue::default();
            let result = queue
                .submit("call", json!({}), Duration::from_millis(1))
                .await;
            assert_eq!(result["code"], "NOT_READY");
            assert!(queue.work.lock().unwrap().queued.is_empty());
        });
    }

    #[test]
    fn started_work_reports_unknown_and_completes_before_next() {
        pipe::runtime().unwrap().block_on(async {
            let queue = std::sync::Arc::new(Queue::default());
            let caller = queue.clone();
            let reply = tokio::spawn(async move {
                caller
                    .submit("call", json!({}), Duration::from_millis(50))
                    .await
            });
            let job = queue.next().await.unwrap();
            assert_eq!(reply.await.unwrap()["code"], "UNKNOWN_OUTCOME");
            assert!(queue.complete("wrong", json!({"ok":true})).is_err());
            assert!(queue.complete(&job.id, json!({"ok":true})).is_ok());
            assert!(queue.complete(&job.id, json!({"ok":true})).is_ok());
        });
    }
}
