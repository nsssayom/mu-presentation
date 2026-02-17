# Mu Presentation — Slide-by-Slide Narration

A walkthrough of "Microsecond Consensus for Microsecond Applications" (OSDI 2020).
Each section below corresponds to one slide. Deliver at a natural pace; the full narration runs approximately 30–35 minutes.

---

## Slide 1 — Title

This is Mu, the Greek letter μ, from OSDI 2020. By Aguilera, Ben-David, Guerraoui, Marathe, Xygkis, and Zablotchi.

The title captures the paper's ambition: microsecond consensus for microsecond applications. We'll walk through what that means, why the authors argue it's hard, and how they approach it.

---

## Slide 2 — State Machine Replication (SMR)

To understand what Mu is solving, we first need to talk about state machine replication.

If you're building a distributed service and you need it to survive machine failures, the standard approach is SMR. You keep multiple copies of the service, each with its own log of client requests. A leader orders those requests, replicates them to a majority of replicas, and every replica applies them in the same order. If the application is deterministic, all replicas stay identical.

Why a majority? Because any two majorities overlap in at least one replica. That overlap prevents two different values from both being committed for the same log slot. This gives you linearizability: the service behaves as a single copy, and every operation takes effect at exactly one instant between call and return.

Classic Paxos achieves this with increasing proposal numbers and a two-phase protocol: prepare, then accept, with follower responses on the critical path. Each of those steps costs microseconds. Keep that in mind as we look at the problem.

---

## Slide 3 — The Problem

Here's the problem in one sentence. Modern applications finish useful work in a few microseconds. But state machine replication adds tens to hundreds of microseconds of replication overhead, and tens to hundreds of milliseconds of failover time.

At microsecond scale, that overhead isn't just overhead anymore. It is the entire latency budget. If your application completes in four microseconds and replication adds fifty, replication just became twelve times more expensive than the actual work.

The paper's central claim: you can't just optimize existing protocols. You need a fundamentally different lever.

---

## Slide 4 — Where Microseconds Matter

Why care about microsecond replication? The paper motivates this with three domains.

Financial trading. Microseconds literally equal money. If your replicated matching engine adds a few extra microseconds, you lose trades to faster competitors.

Embedded control. Microseconds equal safety. Real-time control loops can only afford fault tolerance if the replication cost is nearly invisible.

Microservices. Latency compounds across service graphs. If every stateful component on the critical path adds replication overhead, total round-trip time grows multiplicatively.

The paper's argument: if replication costs several microseconds or failover takes milliseconds, practitioners either accept the overhead or skip replication entirely.

---

## Slide 5 — RDMA: The Lever

Now for the second piece of background: RDMA, Remote Direct Memory Access. This is what the paper calls its "lever."

RDMA provides one-sided operations, Write and Read, that complete without the remote CPU running any receive code. The NIC transfers data directly into or out of registered memory. This is how RDMA achieves low latency and low jitter.

But RDMA is not magic shared memory. It has a real protection model. Two objects matter here.

A Memory Region, or MR, is registered user memory the NIC can access. It carries access flags that control whether remote reads or writes are allowed.

A Queue Pair, or QP, is the endpoint you post RDMA work requests to. It also has access flags and goes through a state machine: RESET, INIT, RTR, RTS. Mu uses Reliable Connection transport, which provides reliable, in-order delivery between connected QP pairs.

The property that matters for Mu: these permissions are hardware-enforced. You can set things up so a remote peer can only write if both its QP and the target MR allow it, and you can change those permissions dynamically. A remote RDMA write either succeeds or fails based on the current permission state. Mu builds its safety mechanism on top of this.

---

## Slide 6 — Mu's Two Core Ideas

Mu introduces two ideas that work together.

First: silent followers. In the common case, the leader replicates by writing directly into each follower's log using one-sided RDMA. Followers do zero network communication on the fast path. No acknowledgments, no participation in the critical path at all. The authors argue this approaches the practical lower bound of what RDMA hardware can do for replication: essentially one round of one-sided operations.

Second: permission equals safety. Mu makes "who can write to a replica's log" an explicit invariant. Each replica grants RDMA write permission to exactly one leader at a time. So Mu prevents two leaders from racing not through proposal numbers and follower replies like Paxos, but through hardware access control: a competing leader's writes fail because the NIC rejects them.

These two ideas together are how Mu aims to achieve microsecond replication while preserving safety.

---

## Slide 7 — Two-Plane Architecture

This figure shows Mu's architecture. The system splits into two planes running on separate threads, separate QPs, and separate MRs.

The replication plane is the fast path. Its job is steady-state replication: receive a request, write it to follower logs, commit, respond.

The background plane handles everything else: failure detection, leader election, permission management, and catch-up. These operations can tolerate higher latency because they happen less frequently, typically when something goes wrong or a replica needs to synchronize.

The important structural point: these two planes are isolated by design. The replication plane never blocks on background operations, and vice versa.

---

## Slide 8 — The Background Plane

Let me go deeper on the background plane, because you need to understand it to follow the rest of the talk.

It has four responsibilities. Failure detection, using pull-score heartbeat monitoring over RDMA reads, which we'll cover later. Leader election, based on a simple rule: the leader is the lowest-ID replica considered alive. Permission management, the revoke-and-grant protocol for RDMA write access during leader transitions. And catch-up and recovery, which synchronizes lagging or recovering replicas.

Why does this need to be separate? Because background work must never block the fast-path replication thread. If a permission change or catch-up operation stalled the replication thread, you'd lose the microsecond latency guarantee. Separate QPs keep control-plane RDMA operations from queuing behind data-plane writes. Separate MRs keep permission changes on the background region from disrupting replication MR access.

The paper treats this isolation as a correctness requirement at microsecond scale, not merely an optimization.

---

## Slide 9 — Part I: Normal Operation (Section Divider)

Let's walk through how Mu actually works, starting with the normal case: the fast path when everyone agrees on who the leader is.

---

## Slide 10 — The Fast Path

Picture a system with three replicas. One is the leader, and everyone agrees on that. Each replica has granted RDMA write permission on its log to the current leader, and nobody else.

A client request arrives. Mu uses a thin "capture and inject" shim that intercepts requests before they reach the application so they can be replicated. Later, it injects them into each replica's application for deterministic replay. The request itself is treated as an opaque byte sequence.

Now the fast path runs: the leader appends the request to its next log slot, then issues RDMA writes to each follower's log. These are one-sided writes. The follower CPUs aren't involved at all. Once the leader confirms the request is on a majority (for three replicas, that's any two of three), it executes and responds to the client. Followers later notice the new entry in their own local memory and replay it.

The authors argue this is near the practical lower bound of what RDMA can do for replication. One round of one-sided writes. It's hard to see how you could do less and still replicate to a majority.

---

## Slide 11 — Replication in Action (Animation)

Let me walk through this step by step.

*[Click 1]* The client sends a request to the leader.

*[Click 2]* The leader appends it to the local log. You can see v1 appearing in the first slot.

*[Click 3]* Now the key step. The leader fires one-sided RDMA writes to both followers' logs simultaneously. See the dashed blue lines? Those are RDMA writes going through the network. And look at the follower CPUs: they say "CPU idle, not involved." The NIC handles the memory write directly. The follower CPU never executes any code for this.

*[Click 4]* Both followers now have v1. The entry is on all three replicas, so it's committed. Total time: about 1.3 microseconds.

*[Click 5]* The leader executes the request and sends the response back to the client.

*[Click 6]* Finally, followers independently discover the new entry and replay it through their local application copy. This happens asynchronously, off the critical path.

So in steady state, the pattern is: leader writes into follower logs, followers replay locally, everyone stays in sync, and no follower network traffic touches the critical path.

---

## Slide 12 — Per-Replica Data Structures

Each replica maintains a few key data structures. The log itself is a registered Memory Region, writable only by the current leader over RDMA.

The First Undecided Offset, FUO, tracks the lowest log index that the replica considers undecided. In steady state, FUO advances as entries get decided and applied.

Each log slot holds a proposal number and a value.

And at the end of each entry sits a canary byte, which prevents followers from reading half-written RDMA entries. We'll see how that works next.

---

## Slide 13 — Making It Actually Correct

Four details make the fast path actually correct.

First, the canary byte. RDMA writes aren't transactional. A follower could see a partially written log entry if it reads while the leader is mid-write. Mu handles this with a simple trick: the leader places a non-zero canary byte at the end of each entry. The follower checks the canary before trusting the data. On most NIC and NUMA configurations, memory becomes visible left to right, so the canary at the end is the last thing to appear. The paper notes you could use a checksum instead to be robust across all hardware.

Second, commit piggybacking. Paxos normally sends an explicit "chosen" message. Mu avoids that. Since the leader only moves forward once earlier slots are decided, followers can treat the highest contiguous non-empty prefix of the log as committed, minus possibly the last entry. The next write effectively serves as the commit signal for the previous slot.

Third, log recycling. The log is circular. Entries get reused once every replica has applied them. We'll see the details when we discuss catch-up.

Fourth, and most important for performance: prepare omission. Once a leader sees only empty slots at some FUO across its confirmed followers, it skips the prepare phase for all subsequent indices. This is how the common-case cost drops to just one round of one-sided RDMA writes.

---

## Slide 14 — Part II: Safety & Leader Change (Section Divider)

Now we move to the harder part. The real challenge in consensus isn't steady-state replication. It's preventing split-brain and races between concurrent leaders during failure suspicion, network jitter, or delayed scheduling. This section covers split-brain prevention, failure detection, leader change, edge cases, and recovery.

---

## Slide 15 — Why Concurrent Leaders Are Dangerous

Why do concurrent leaders matter? If a leader appears slow or dead, another replica will try to take over. Now two replicas both think they're leader, potentially writing different values to the same log slot. That's the split-brain problem.

The classic fix is extra message rounds and follower promises: "I won't accept proposals with a lower number than yours." Each round adds microseconds to the critical path.

Mu takes a different approach. Instead of relying on follower promises, it makes unauthorized writes physically impossible. Not "the follower promises not to accept," but "the NIC rejects the write because the QP doesn't have the required permission flags." Safety through hardware access control.

The paper's main contribution is arguably here, not in the fast path itself, but in handling the hard case: races during failure suspicion, network jitter, and scheduling delays.

---

## Slide 16 — Permission-Based Safety

Here's how Mu's permission system works in detail.

The invariant: each replica grants RDMA write permission on its log to exactly one leader at a time. This is hardware-enforced. If an unauthorized leader tries to write, the NIC silently drops the operation. No error propagates. The data just doesn't land.

When permissions need to change during a leader transition, the would-be leader writes a permission request into the target replica's background-plane Memory Region. This is itself a one-sided RDMA write into a permission request array that each replica maintains. The log owner's background thread picks up the request, revokes access from the current holder by modifying QP or MR flags, then grants access to the requester. If multiple replicas request simultaneously, they're processed one at a time, ordered by replica ID. That deterministic ordering prevents races between competing candidates.

Only after this revoke-and-grant cycle completes does the replica join the new leader's confirmed followers set. Any in-flight writes from the old leader silently fail after revocation. They just don't land.

The permission switch turns out to be the dominant cost of failover: hundreds of microseconds on current NICs. We'll see the exact numbers later. Conceptually, the paper's argument is that Paxos proposal numbers can be replaced by hardware access control. Safety comes from the NIC, not from protocol messages.

---

## Slide 17 — Pull-Score Failure Detection

How does Mu detect that a leader has failed?

Traditional push-based heartbeats have the leader send periodic messages. But network jitter delays those messages, so you need conservatively large timeouts to avoid false positives. At microsecond scale, that means you either tolerate slow detection or suffer constant false leader changes.

Mu uses a pull-based approach instead. Each replica maintains a heartbeat counter that increments as it makes progress. Other replicas periodically RDMA-read that counter. If the counter changed since last check, the score decreases, things look healthy. If it hasn't changed, the score increases, potential problem. Scores are bounded between 0 and 15, with a failure threshold at 2 and a recovery threshold at 6.

Here's the subtle part. With push heartbeats, network delay creates a sudden silent gap you have to distinguish from real failure. With pull-score, network delay just slows down how fast you accumulate "same value" observations. There's no sudden gap to misinterpret. This lets you set aggressive thresholds without triggering spurious leader changes under normal datacenter conditions.

There's also a two-layer design. The pull-score threshold handles common, brief failures like scheduling stalls. A longer connection-level timeout handles major disruptions like network breakage or machine crashes. The gap between the failure threshold at 2 and recovery threshold at 6 provides hysteresis that prevents oscillation.

---

## Slide 18 — Leader Election & Fate Sharing

Leader election in Mu is simple in policy, careful in mechanism.

The policy: each replica locally decides that the leader is the lowest-ID replica it considers alive. No voting protocol needed. The goal is determinism: if everyone agrees on who's alive, they automatically agree on the leader.

But there's a practical complication the paper calls fate sharing. Replication and election run on separate threads, so you can hit a nasty case: the election thread is healthy and the replica appears alive, but the replication thread is stuck. Maybe it hit a bug or lock contention. Progress stalls, but no leader change happens because the failure detector still sees a healthy heartbeat.

Mu fixes this by having the election thread periodically check whether replication is actually making progress. If it isn't, the election thread stops incrementing the heartbeat counter, which causes other replicas to suspect and replace this leader.

This reflects a recurring theme in the paper: at microsecond scale, system behavior is often dominated by engineering pathologies rather than algorithmic complexity. Fate sharing is a practical fix for a real systems problem.

---

## Slide 19 — Leader Change Process

When a leader is suspected to have failed, the change process has five steps.

One: the pull-score detector triggers, and the local leader rule kicks in. The next replica in line, the lowest-ID replica still considered alive, starts acting as the new leader.

Two: the new leader requests permissions from each replica via the background plane, writing into their permission request arrays.

Three: each replica's background thread processes the request. It revokes write access from the old leader and grants it to the new one.

Four: the new leader catches up. It reads the FUO from each confirmed follower and copies missing entries from whichever follower is most advanced.

Five: the new leader pushes missing entries to any lagging replicas and aligns their FUOs.

The figure on the right shows this visually.

---

## Slide 20 — Edge Cases During Leader Change

Leader change sounds clean on paper, but several edge cases come up.

The old leader might still be alive. Maybe it was just briefly slow, or the detection was premature. It might try to write after being suspected. This is safe: its RDMA writes silently fail once permissions are revoked. The NIC rejects them.

Multiple replicas might suspect the leader at the same time and all try to become the new leader. The permission manager handles this by processing requests one at a time, ordered by replica ID. Deterministic ordering means exactly one candidate wins.

The old leader might have written an entry to some followers but not a majority before losing permission. The new leader's prepare phase discovers these partial entries by RDMA-reading slot state from confirmed followers. It can then complete or override the partial proposal.

Why does all of this stay safe? The confirmed followers set means what it says: those replicas have revoked the old leader and granted the new one. The new leader only operates on confirmed followers, so there's guaranteed no concurrent writer. The prepare phase reads slot state to resolve any in-flight proposals before moving forward.

The bottom line: safety doesn't depend on timing or promises. It's enforced by hardware permission state at the NIC.

---

## Slide 21 — Catch-Up & Log Recovery

Catch-up and log recovery are what make Mu a complete SMR system rather than just a fast-path optimization.

When a new leader takes over, all replicas need to be consistent. The catch-up process: RDMA-read the FUO from each confirmed follower, copy missing entries from the most advanced follower, then push what's missing to lagging followers and align their FUOs. Without this, any replica outside the confirmed set would drift indefinitely.

On the right: circular log recycling, which keeps the log finite. Each follower tracks a log-head pointer, the first entry not yet applied locally. The leader periodically RDMA-reads all head pointers and computes minHead, the minimum across all followers. Entries below minHead are safe to zero out and reuse.

The zeroing step matters more than it looks. The canary byte mechanism depends on empty entries being distinguishable from written ones. If you reuse a slot without zeroing it, a follower could mistake a stale canary from a previous round for a fresh write. Zeroing guarantees that a non-zero canary always means a freshly written entry.

---

## Slide 22 — Permission Switch Mechanisms

Here's something the paper discovered is a surprising bottleneck: the cost of changing RDMA permissions.

Normal RDMA reads and writes complete in low single-digit microseconds. But changing the permissions that enable safe leader transitions is far slower.

The paper evaluates three mechanisms. MR re-registration is the most flexible but the most expensive: 350 to 56,700 microseconds, scaling badly with region size. The NIC firmware has to update page tables, and that's a control-plane bottleneck.

QP access flag changes are much faster at about 88 microseconds, but they can trigger an error state if RDMA operations are in flight when you modify the flags.

QP state cycling, transitioning through RESET and back to RTS, is robust regardless of in-flight operations but costs about 1,216 microseconds.

Mu uses a fast-then-slow strategy: try the fast QP flag change first. If it errors because operations were in flight, fall back to the robust QP state cycle.

This speaks to a broader observation in the paper: microsecond SMR hits hardware control-plane costs that traditional systems never had to worry about. The fast path runs in microseconds, but leader changes are bounded by what NIC firmware and driver stacks are designed for.

---

## Slide 23 — Part III: Evaluation (Section Divider)

Let's look at how Mu performs in practice. The evaluation uses a four-node cluster with 100 Gbps InfiniBand, dual Xeon E5-2640 v4 CPUs, Ubuntu 18.04, and Mellanox OFED drivers. They evaluate three-way replication.

---

## Slide 24 — Replication Latency

This figure compares replication latency across systems, with Mu attached to different applications.

Mu with Liquibook reports 1.34 microseconds median. Mu with HERD is 1.40. With TCP-based apps like Redis and Memcached, Mu stays at 1.68 microseconds, since the replication path is the same regardless of what application is attached.

The baselines: DARE is at 5.15 microseconds, Hermes at 4.55, and APUS at 6.80 to 6.86. So Mu is roughly 3 to 5 times faster in the median. The error bars also differ noticeably. Mu shows a tighter tail, while the other systems show wider spread, likely because they involve follower CPUs in the critical path, and serializing multiple RDMA events compounds timing variance.

---

## Slide 25 — Standalone vs. Attached Performance

This figure shows Mu's replication latency across different payload sizes, comparing standalone mode against Mu attached to real applications like Redis, Memcached, HERD, and Liquibook.

At small sizes, 32 to 128 bytes, all modes perform similarly, around 1.29 to 1.72 microseconds. Standalone is slightly faster since there's no cache interference from a co-located application.

The interesting jump happens at 256 bytes. That's the RDMA inline threshold in their setup. Below 256 bytes, the NIC can inline the payload directly into the work request, avoiding an extra DMA fetch from host memory. Past that point, latency rises more steeply, and the gap between standalone and attached widens because cache pressure from the application starts to matter more.

What this suggests: at microsecond scale, thread and core topology becomes a first-order design choice. A fast algorithm alone isn't sufficient. You also need to think about where threads are pinned, how cache lines bounce between cores, and whether your payloads fit the inline threshold.

---

## Slide 26 — End-to-End Application Latency

This addresses a more practical question: how does replication overhead compare to the application's own work? The figure has three panels.

Left panel, Liquibook, a financial exchange matching engine. Unreplicated median is 4.08 microseconds, replicated with Mu it's 5.55. That's about 35% overhead.

Middle panel, RDMA key-value stores. HERD goes from 2.25 unreplicated to 3.59 with Mu. DARE, by contrast, adds overhead up to 7.56 microseconds, more than tripling the unreplicated latency.

Right panel, TCP-based Redis and Memcached. The base latency is already around 115 to 117 microseconds unreplicated. Mu adds about 1.4 to 1.6 microseconds, which is negligible relative to the TCP baseline. APUS adds more, around 4 to 7 microseconds, but that's still small in proportion.

The authors' argument: for true microsecond applications like Liquibook and HERD, even 1.3 microseconds matters. Among the systems compared, Mu has the lowest overhead for these workloads. Whether that overhead is acceptable depends on the application's tolerance, but the other systems in this comparison add considerably more.

---

## Slide 27 — Failover Performance

This figure shows two histograms side by side.

On the left, permission switch time, centered around 230 to 235 microseconds. That's the cost of revoking the old leader's RDMA access and granting it to the new one, consistent with the QP access flag mechanism we discussed earlier.

On the right, total failover time, centered around 870 to 875 microseconds. The difference between the two, roughly 640 microseconds, accounts for failure detection via pull-score and any catch-up overhead.

The experiment injects failure by delaying the leader until it becomes unresponsive, triggering pull-score suspicion at the followers. Total failover stays sub-millisecond, compared to the tens to hundreds of milliseconds typical in traditional SMR systems.

Both histograms are tightly clustered, suggesting predictable behavior under failure rather than a long tail of recovery times.

---

## Slide 28 — What Mu Achieves

Let's step back and summarize what Mu reports.

About 1.3 microseconds median replication latency. 873 microseconds median failover. These are the lowest numbers among the systems compared in the paper.

In the common case, it approaches the RDMA lower bound: one round of one-sided writes, which is close to the minimum needed for majority replication.

It provides linearizability through hardware-enforced single-writer permissions rather than protocol-level quorum responses.

It integrates with real applications: Liquibook, HERD, Redis, Memcached. And it covers the full SMR lifecycle: leader change, log recycling, catch-up, not just the fast path.

---

## Slide 29 — Limitations & Open Questions

Some limitations worth noting.

RDMA is required. This targets datacenter and LAN environments with InfiniBand or RoCE. It doesn't apply to WAN deployments.

It's in-memory only. There's no durable logging to stable storage. The paper mentions persistent memory as a future direction.

Permission switching costs hundreds of microseconds on current NICs. The fast-slow QP strategy helps, but the fundamental cost is a hardware control-plane bottleneck.

The canary byte scheme relies on certain NIC and NUMA placement conditions for left-to-right visibility ordering. A checksum alternative is discussed for robustness across hardware, but that adds cost.

More broadly, Mu shifts work from the network data plane to the RDMA control plane. The fast path is microseconds, but the slow path is bounded by what NIC firmware and drivers are designed for today.

---

## Slide 30 — Our Take

Let me share our overall impression of the paper.

What I liked. The core idea of using RDMA write permissions as a distributed systems safety primitive is genuinely creative. Others had used RDMA for faster replication, but treating the NIC's access control as the mechanism for preventing split-brain is a real conceptual contribution. I also appreciate that this is a complete system. It doesn't stop at the fast path. It covers leader change, catch-up, log recycling, and real application integration. And the paper is honest about its hardware costs, like the permission switch latency and the canary byte assumptions. That kind of transparency is refreshing.

Where I have questions. First, generality. The entire approach depends on RDMA hardware, which limits deployment to InfiniBand or RoCE-equipped clusters. It's not clear how the ideas translate beyond that context. Second, durability. The system is in-memory only. For the motivating use cases like financial trading, you'd likely want durable replication, and the paper leaves that for future work. Third, the evaluation baselines. DARE, Hermes, and APUS were reasonable comparisons at the time, but they're not the newest systems. It's fair to wonder whether the performance gap would narrow with more recent RDMA-based approaches.

Overall, I think it's a strong systems paper that moves the needle on what's possible with RDMA-based consensus, while leaving some legitimate open questions about scope and assumptions.

---

## Slide 31 — Thank You

Thank you. Happy to take questions.
