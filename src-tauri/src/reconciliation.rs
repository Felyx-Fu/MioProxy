use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceConnectivity {
    NotInstalled,
    ServiceStopped,
    ScmStarting,
    PipeNotReady,
    Transient,
    Ambiguous,
    Ready,
    ProtocolFailure,
    AuthenticationFailure,
    CommandFailure,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TunProjectionState {
    WaitingForService,
    Enabling,
    On,
    Disabling,
    Recovering,
    External,
    Error,
    #[default]
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunActualState {
    Disabled,
    Enabled,
    Transitioning,
    External,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationOutcome {
    NotSent,
    Applied,
    Ambiguous,
    DeterministicFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileDecision {
    Wait(TunProjectionState),
    IssueMutation,
    Complete,
    AbortExternal,
    Fail(ServiceConnectivity),
    Stale,
}

#[derive(Debug, Clone, Copy)]
pub struct TunReconciler {
    desired_enabled: bool,
    generation: u64,
    mutation_pending: bool,
    ambiguous_mutation: bool,
    applied_observations: u8,
}

impl TunReconciler {
    pub fn new(desired_enabled: bool, generation: u64) -> Self {
        Self {
            desired_enabled,
            generation,
            mutation_pending: false,
            ambiguous_mutation: false,
            applied_observations: 0,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn desired_enabled(&self) -> bool {
        self.desired_enabled
    }

    pub fn observe(
        &mut self,
        generation: u64,
        connectivity: ServiceConnectivity,
        actual: TunActualState,
        external_detected: bool,
    ) -> ReconcileDecision {
        if generation != self.generation {
            return ReconcileDecision::Stale;
        }
        if external_detected || matches!(actual, TunActualState::External) {
            return ReconcileDecision::AbortExternal;
        }
        if matches!(
            connectivity,
            ServiceConnectivity::ProtocolFailure
                | ServiceConnectivity::AuthenticationFailure
                | ServiceConnectivity::CommandFailure
        ) {
            return ReconcileDecision::Fail(connectivity);
        }
        if self.desired_enabled && matches!(actual, TunActualState::Enabled)
            || !self.desired_enabled && matches!(actual, TunActualState::Disabled)
        {
            return ReconcileDecision::Complete;
        }
        if !matches!(connectivity, ServiceConnectivity::Ready) {
            return ReconcileDecision::Wait(if self.ambiguous_mutation {
                TunProjectionState::Recovering
            } else {
                TunProjectionState::WaitingForService
            });
        }
        if matches!(
            actual,
            TunActualState::Transitioning | TunActualState::Unknown
        ) {
            return ReconcileDecision::Wait(if self.ambiguous_mutation {
                TunProjectionState::Recovering
            } else if self.desired_enabled {
                TunProjectionState::Enabling
            } else {
                TunProjectionState::Disabling
            });
        }
        if self.mutation_pending && !self.ambiguous_mutation {
            if self.applied_observations < 3 {
                self.applied_observations += 1;
                return ReconcileDecision::Wait(if self.desired_enabled {
                    TunProjectionState::Enabling
                } else {
                    TunProjectionState::Disabling
                });
            }
            self.mutation_pending = false;
        }
        self.mutation_pending = true;
        self.ambiguous_mutation = false;
        self.applied_observations = 0;
        ReconcileDecision::IssueMutation
    }

    pub fn record_mutation(
        &mut self,
        generation: u64,
        outcome: MutationOutcome,
    ) -> ReconcileDecision {
        if generation != self.generation {
            return ReconcileDecision::Stale;
        }
        match outcome {
            MutationOutcome::NotSent => {
                self.mutation_pending = false;
                self.ambiguous_mutation = false;
                self.applied_observations = 0;
                ReconcileDecision::Wait(TunProjectionState::WaitingForService)
            }
            MutationOutcome::Applied => {
                self.mutation_pending = true;
                self.ambiguous_mutation = false;
                self.applied_observations = 0;
                ReconcileDecision::Wait(if self.desired_enabled {
                    TunProjectionState::Enabling
                } else {
                    TunProjectionState::Disabling
                })
            }
            MutationOutcome::Ambiguous => {
                self.mutation_pending = true;
                self.ambiguous_mutation = true;
                self.applied_observations = 0;
                ReconcileDecision::Wait(TunProjectionState::Recovering)
            }
            MutationOutcome::DeterministicFailure => {
                ReconcileDecision::Fail(ServiceConnectivity::CommandFailure)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MutationOutcome, ReconcileDecision, ServiceConnectivity, TunActualState,
        TunProjectionState, TunReconciler,
    };

    const GENERATION: u64 = 41;

    #[test]
    fn service_start_pending_then_pipe_ready_converges_tun_on() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::ScmStarting,
                TunActualState::Unknown,
                false,
            ),
            ReconcileDecision::Wait(TunProjectionState::WaitingForService)
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Disabled,
                false,
            ),
            ReconcileDecision::IssueMutation
        );
        assert_eq!(
            reconciler.record_mutation(GENERATION, MutationOutcome::Applied),
            ReconcileDecision::Wait(TunProjectionState::Enabling)
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Enabled,
                false,
            ),
            ReconcileDecision::Complete
        );
    }

    #[test]
    fn pipe_busy_is_waiting_and_does_not_issue_duplicate_mutations() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        for _ in 0..3 {
            assert_eq!(
                reconciler.observe(
                    GENERATION,
                    ServiceConnectivity::Transient,
                    TunActualState::Disabled,
                    false,
                ),
                ReconcileDecision::Wait(TunProjectionState::WaitingForService)
            );
        }
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Disabled,
                false,
            ),
            ReconcileDecision::IssueMutation
        );
        assert_eq!(
            reconciler.record_mutation(GENERATION, MutationOutcome::Applied),
            ReconcileDecision::Wait(TunProjectionState::Enabling)
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Transitioning,
                false,
            ),
            ReconcileDecision::Wait(TunProjectionState::Enabling)
        );
    }

    #[test]
    fn lost_response_with_tun_enabled_completes_without_second_mutation() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Disabled,
                false,
            ),
            ReconcileDecision::IssueMutation
        );
        assert_eq!(
            reconciler.record_mutation(GENERATION, MutationOutcome::Ambiguous),
            ReconcileDecision::Wait(TunProjectionState::Recovering)
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Enabled,
                false,
            ),
            ReconcileDecision::Complete
        );
    }

    #[test]
    fn lost_response_with_tun_disabled_retries_only_after_status_proves_required() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Disabled,
                false,
            ),
            ReconcileDecision::IssueMutation
        );
        assert_eq!(
            reconciler.record_mutation(GENERATION, MutationOutcome::Ambiguous),
            ReconcileDecision::Wait(TunProjectionState::Recovering)
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Transient,
                TunActualState::Unknown,
                false,
            ),
            ReconcileDecision::Wait(TunProjectionState::Recovering)
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ready,
                TunActualState::Disabled,
                false,
            ),
            ReconcileDecision::IssueMutation
        );
    }

    #[test]
    fn stale_generation_cannot_complete_newer_tun_intent() {
        let mut reconciler = TunReconciler::new(false, 42);
        assert_eq!(
            reconciler.observe(
                41,
                ServiceConnectivity::Ready,
                TunActualState::Disabled,
                false,
            ),
            ReconcileDecision::Stale
        );
        assert_eq!(reconciler.generation(), 42);
        assert!(!reconciler.desired_enabled());
    }

    #[test]
    fn ipc_disconnect_while_tun_on_never_turns_it_off() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Transient,
                TunActualState::Enabled,
                false,
            ),
            ReconcileDecision::Complete
        );
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Ambiguous,
                TunActualState::Unknown,
                false,
            ),
            ReconcileDecision::Wait(TunProjectionState::WaitingForService)
        );
    }

    #[test]
    fn external_tun_during_recovery_aborts_safely() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::Transient,
                TunActualState::Unknown,
                true,
            ),
            ReconcileDecision::AbortExternal
        );
    }

    #[test]
    fn protocol_and_auth_failures_remain_fail_closed() {
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::ProtocolFailure,
                TunActualState::Unknown,
                false,
            ),
            ReconcileDecision::Fail(ServiceConnectivity::ProtocolFailure)
        );
        let mut reconciler = TunReconciler::new(true, GENERATION);
        assert_eq!(
            reconciler.observe(
                GENERATION,
                ServiceConnectivity::AuthenticationFailure,
                TunActualState::Unknown,
                false,
            ),
            ReconcileDecision::Fail(ServiceConnectivity::AuthenticationFailure)
        );
    }
}
