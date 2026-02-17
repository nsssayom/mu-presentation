# Mu Presentation — Slide-by-Slide Narration

A lossless walkthrough of "Microsecond Consensus for Microsecond Applications" (OSDI 2020).
Each section below corresponds to one slide. Deliver at a natural pace; the full narration runs approximately 35–40 minutes.

---

## Slide 1 — Title

This is Mu, the Greek letter μ, from OSDI 2020. By Aguilera, Ben-David, Guerraoui, Marathe, Xygkis, and Zablotchi.

The title captures the whole ambition: microsecond consensus for microsecond applications. By the end of this talk, you'll know exactly what that means, why it's hard, and how Mu pulls it off.

---

## Slide 2 — The Problem

Here's the problem in one sentence. Modern applications finish useful work in a few microseconds. But state machine replication adds tens to hundreds of microseconds of replication overhead, and tens to hundreds of milliseconds of failover time.

At microsecond scale, that overhead isn't just overhead anymore. It is the entire latency budget. If your application completes in four microseconds and replication adds fifty, replication just became twelve times more expensive than the actual work.

The paper's central claim: you can't just optimize existing protocols. You need a fundamentally different lever.

---

## Slide 3 — Where Microseconds Matter

Why care about microsecond replication? The paper motivates this with three domains.

Financial trading. Microseconds literally equal money. If your replicated matching engine adds a few extra microseconds, you lose trades to faster competitors.

Embedded control. Microseconds equal safety. Real-time control loops can only afford fault tolerance if the replication cost is nearly invisible.

Microservices. Latency compounds across service graphs. If every stateful component on the critical path adds replication overhead, total round-trip time grows multiplicatively.

Bottom line: if replication costs several microseconds or failover takes milliseconds, people either accept the competitive disadvantage or just skip replication entirely.

---

## Slide 4 — State Machine Replication (SMR)

Before we get to Mu's solution, two pieces of background. First: state machine replication.

SMR is the gold standard for making a distributed service look like a single, reliable copy. Each replica keeps a copy of the application and a log of client requests. The leader orders requests, replicates them to a majority, and every replica applies entries in the same order. If the application is deterministic, all replicas stay identical.

Why a majority? Because any two majorities overlap in at least one replica. That overlap prevents two different values from both being committed for the same log slot. This gives you linearizability: the replicated service behaves as a single copy, and every operation takes effect at exactly one instant between call and return.

Classic Paxos does this with increasing proposal numbers and a two-phase protocol: prepare, then accept, with follower responses on the critical path. Each step costs microseconds. Mu's question is: can we do better?

---

## Slide 5 — RDMA: The Lever

Second piece of background: RDMA, Remote Direct Memory Access. This is Mu's lever.

RDMA gives you one-sided operations, Write and Read, that complete without the remote CPU running any receive code. The NIC transfers data directly into or out of registered memory. That's why RDMA can achieve extremely low latency and low jitter when used carefully.

But RDMA is not magic shared memory. It has a real protection model. Two objects matter here.

A Memory Region, or MR, is registered user memory the NIC can access. It carries access flags that control whether remote reads or writes are allowed.

A Queue Pair, or QP, is the endpoint you post RDMA work requests to. It also has access flags and goes through a state machine: RESET, INIT, RTR, RTS. Mu uses Reliable Connection transport, which provides reliable, in-order delivery between connected QP pairs.

Here's the critical insight for Mu: these permissions are hardware-enforced. You can set things up so a remote peer can only write if both its QP and the target MR allow it, and you can change those permissions dynamically. A remote RDMA write either succeeds or fails based on the current permission state. That hardware enforcement is exactly what Mu will exploit.

---

## Slide 6 — Mu's Two Core Ideas

Mu introduces two ideas that work together.

First: silent followers. In the common case, the leader replicates by writing directly into each follower's log using one-sided RDMA. Followers do zero network communication on the fast path. No acknowledgments, no participation in the critical path at all. The paper argues this reaches the practical lower bound of what RDMA hardware can do for replication: essentially one round of one-sided operations.

Second: permission equals safety. Mu makes "who can write to a replica's log" an explicit invariant. Each replica grants RDMA write permission to exactly one leader at a time. So the way Mu prevents two leaders from racing isn't through proposal numbers and follower replies like Paxos. It's through hardware access control: a competing leader's writes literally fail because the NIC rejects them at the hardware level.

These two ideas together are what make microsecond replication possible while keeping the system safe.

---

## Slide 7 — Two-Plane Architecture

This figure shows Mu's architecture. The system splits into two planes running on separate threads, separate QPs, and separate MRs.

The replication plane is the fast path. Its only job is steady-state replication: receive a request, write it to follower logs, commit, respond. Everything about it is optimized for speed.

The background plane handles everything else: failure detection, leader election, permission management, and catch-up. These operations can tolerate higher latency because they happen rarely, only when something goes wrong or a replica needs to synchronize.

The key takeaway from this diagram: these two planes are isolated by design. The replication plane never blocks on background operations, and vice versa.

---

## Slide 8 — The Background Plane

Let me go deeper on the background plane, because you need to understand it to follow the rest of the talk.

It has four responsibilities. Failure detection, using pull-score heartbeat monitoring over RDMA reads, which we'll cover later. Leader election, based on a simple rule: the leader is the lowest-ID replica considered alive. Permission management, the revoke-and-grant protocol for RDMA write access during leader transitions. And catch-up and recovery, which synchronizes lagging or recovering replicas.

Why does this need to be separate? Because background work must never block the fast-path replication thread. If a permission change or catch-up operation stalled the replication thread, you'd lose the microsecond latency guarantee. Separate QPs keep control-plane RDMA operations from queuing behind data-plane writes. Separate MRs keep permission changes on the background region from disrupting replication MR access.

This isolation isn't an optimization. At microsecond scale, it's a correctness requirement.

---

## Slide 9 — Part I: Normal Operation (Section Divider)

Let's walk through how Mu actually works, starting with the normal case: the fast path when everyone agrees on who the leader is.

---

## Slide 10 — The Fast Path

Picture a system with three replicas. One is the leader, and everyone agrees on that. Each replica has granted RDMA write permission on its log to the current leader, and nobody else.

A client request arrives. Mu uses a thin "capture and inject" shim that intercepts requests before they reach the application so they can be replicated. Later, it injects them into each replica's application for deterministic replay. The request itself is treated as an opaque byte sequence.

Now the fast path runs: the leader appends the request to its next log slot, then issues RDMA writes to each follower's log. These are one-sided writes. The follower CPUs aren't involved at all. Once the leader confirms the request is on a majority (for three replicas, that's any two of three), it executes and responds to the client. Followers later notice the new entry in their own local memory and replay it.

The important point: this is the practical lower bound of what RDMA can do for replication. One round of one-sided writes. You can't do less and still get majority acknowledgment.

---

## Slide 11 — Replication in Action (Animation)

Let me walk through this step by step.

*[Click 1]* The client sends a request to the leader.

*[Click 2]* The leader appends it to the local log. You can see v₁ appearing in the first slot.

*[Click 3]* Now the key step. The leader fires one-sided RDMA writes to both followers' logs simultaneously. See the dashed blue lines? Those are RDMA writes going through the network. And look at the follower CPUs: they say "CPU idle, not involved." The NIC handles the memory write directly. The follower CPU never executes any code for this.

*[Click 4]* Both followers now have v₁. The entry is on all three replicas, so it's committed. Total time: about 1.3 microseconds.

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

Now for the hard part. The normal case is elegant, but the real challenge in consensus isn't when everyone agrees on the leader. It's preventing split-brain and races between concurrent leaders during failure suspicion, network jitter, or delayed scheduling. This section covers split-brain prevention, failure detection, leader change, edge cases, and recovery.

---

## Slide 15 — Why Concurrent Leaders Are Dangerous

Why do concurrent leaders matter? If a leader appears slow or dead, another replica will try to take over. Now two replicas both think they're leader, potentially writing different values to the same log slot. That's the split-brain problem.

The classic fix is extra message rounds and follower promises: "I won't accept proposals with a lower number than yours." Each round adds microseconds to the critical path.

Mu takes a different approach entirely. Instead of relying on follower promises, it makes unauthorized writes physically impossible. Not "the follower promises not to accept." Rather, "the NIC rejects the write because the QP doesn't have the required permission flags." Safety through hardware access control.

This is where Mu spends its novelty budget. Not on the happy path, but on the hard case: races during failure suspicion, network jitter, and scheduling delays.

---

## Slide 16 — Permission-Based Safety

Here's how Mu's permission system works in detail.

The invariant: each replica grants RDMA write permission on its log to exactly one leader at a time. This is hardware-enforced. If an unauthorized leader tries to write, the NIC silently drops the operation. No error propagates. The data just doesn't land.

When permissions need to change during a leader transition, the would-be leader writes a permission request into the target replica's background-plane Memory Region. This is itself a one-sided RDMA write into a permission request array that each replica maintains. The log owner's background thread picks up the request, revokes access from the current holder by modifying QP or MR flags, then grants access to the requester. If multiple replicas request simultaneously, they're processed one at a time, ordered by replica ID. That deterministic ordering prevents races between competing candidates.

Only after this revoke-and-grant cycle completes does the replica join the new leader's confirmed followers set. Any in-flight writes from the old leader silently fail after revocation. They just don't land.

The permission switch turns out to be the dominant cost of failover: hundreds of microseconds on current NICs. We'll see the exact numbers later. But conceptually, this is the key insight: Paxos proposal numbers get replaced by hardware access control. Safety comes from the NIC, not from protocol messages.

---

## Slide 17 — Confirmed Followers & The Protocol

Now the consensus protocol itself. Mu maintains a set called "confirmed followers": replicas that have granted exclusive write permission to this leader and revoked it from everyone else. This is stronger than "they replied to a message." It means their NIC permissions guarantee no other leader can concurrently write their logs.

Mu's propose operation looks like Paxos conceptually, but with a key twist: the leader directly reads and writes follower state through RDMA, treating follower memory as published state.

The prepare-like step: RDMA-read the minimum proposal number from confirmed followers, pick a higher number, write it back, and read the slot at FUO.

The accept-like step: RDMA-write the proposal number and value into the FUO slot on confirmed followers.

The crucial safety condition isn't "followers responded and promised." It's: I only touch replicas whose NIC permissions guarantee no other leader can write to them while I operate.

And the key optimization: once a leader sees only empty slots at FUO across confirmed followers, it skips the prepare phase entirely for subsequent indices. That's why the common case costs just one round of one-sided RDMA writes.

---

## Slide 18 — Pull-Score Failure Detection

How does Mu detect that a leader has failed?

Traditional push-based heartbeats have the leader send periodic messages. But network jitter delays those messages, so you need conservatively large timeouts to avoid false positives. At microsecond scale, that means you either tolerate slow detection or suffer constant false leader changes.

Mu uses a pull-based approach instead. Each replica maintains a heartbeat counter that increments as it makes progress. Other replicas periodically RDMA-read that counter. If the counter changed since last check, the score decreases, things look healthy. If it hasn't changed, the score increases, potential problem. Scores are bounded between 0 and 15, with a failure threshold at 2 and a recovery threshold at 6.

Here's the subtle part. With push heartbeats, network delay creates a sudden silent gap you have to distinguish from real failure. With pull-score, network delay just slows down how fast you accumulate "same value" observations. There's no sudden gap to misinterpret. This lets you set aggressive thresholds without triggering spurious leader changes under normal datacenter conditions.

There's also a two-layer design. The pull-score threshold handles common, brief failures like scheduling stalls. A longer connection-level timeout handles major disruptions like network breakage or machine crashes. The gap between the failure threshold at 2 and recovery threshold at 6 provides hysteresis that prevents oscillation.

---

## Slide 19 — Leader Election & Fate Sharing

Leader election in Mu is simple in policy, careful in mechanism.

The policy: each replica locally decides that the leader is the lowest-ID replica it considers alive. No voting protocol needed. The goal is determinism: if everyone agrees on who's alive, they automatically agree on the leader.

But there's a practical complication the paper calls fate sharing. Replication and election run on separate threads, so you can hit a nasty case: the election thread is healthy and the replica appears alive, but the replication thread is stuck. Maybe it hit a bug or lock contention. Progress stalls, but no leader change happens because the failure detector still sees a healthy heartbeat.

Mu fixes this by having the election thread periodically check whether replication is actually making progress. If it isn't, the election thread stops incrementing the heartbeat counter, which causes other replicas to suspect and replace this leader.

This is a good example of the paper's mindset. The correctness model comes from distributed algorithms, but microsecond behavior is often dominated by engineering pathologies, not algorithmic complexity. Fate sharing is a practical fix for a real systems problem.

---

## Slide 20 — Leader Change Process

When a leader is suspected to have failed, the change process has five steps.

One: the pull-score detector triggers, and the local leader rule kicks in. The next replica in line, the lowest-ID replica still considered alive, starts acting as the new leader.

Two: the new leader requests permissions from each replica via the background plane, writing into their permission request arrays.

Three: each replica's background thread processes the request. It revokes write access from the old leader and grants it to the new one.

Four: the new leader catches up. It reads the FUO from each confirmed follower and copies missing entries from whichever follower is most advanced.

Five: the new leader pushes missing entries to any lagging replicas and aligns their FUOs.

The figure on the right shows this visually.

---

## Slide 21 — Edge Cases During Leader Change

Leader change sounds clean on paper, but several edge cases come up.

The old leader might still be alive. Maybe it was just briefly slow, or the detection was premature. It might try to write after being suspected. This is safe: its RDMA writes silently fail once permissions are revoked. The NIC rejects them.

Multiple replicas might suspect the leader at the same time and all try to become the new leader. The permission manager handles this by processing requests one at a time, ordered by replica ID. Deterministic ordering means exactly one candidate wins.

The old leader might have written an entry to some followers but not a majority before losing permission. The new leader's prepare phase discovers these partial entries by RDMA-reading slot state from confirmed followers. It can then complete or override the partial proposal.

Why does all of this stay safe? The confirmed followers set means what it says: those replicas have revoked the old leader and granted the new one. The new leader only operates on confirmed followers, so there's guaranteed no concurrent writer. The prepare phase reads slot state to resolve any in-flight proposals before moving forward.

The bottom line: safety doesn't depend on timing or promises. It's enforced by hardware permission state at the NIC.

---

## Slide 22 — Catch-Up & Log Recovery

Catch-up and log recovery are what make Mu a complete SMR system, not just a clever fast-path trick.

When a new leader takes over, all replicas need to be consistent. The catch-up process: RDMA-read the FUO from each confirmed follower, copy missing entries from the most advanced follower, then push what's missing to lagging followers and align their FUOs. Without this, any replica outside the confirmed set would drift indefinitely.

On the right: circular log recycling, which keeps the log finite. Each follower tracks a log-head pointer, the first entry not yet applied locally. The leader periodically RDMA-reads all head pointers and computes minHead, the minimum across all followers. Entries below minHead are safe to zero out and reuse.

The zeroing step matters more than it looks. The canary byte mechanism depends on empty entries being distinguishable from written ones. If you reuse a slot without zeroing it, a follower could mistake a stale canary from a previous round for a fresh write. Zeroing guarantees that a non-zero canary always means a freshly written entry.

---

## Slide 23 — Permission Switch Mechanisms

Here's something the paper discovered is a surprising bottleneck: the cost of changing RDMA permissions.

Normal RDMA reads and writes complete in low single-digit microseconds. But changing the permissions that enable safe leader transitions is far slower.

The paper evaluates three mechanisms. MR re-registration is the most flexible but the most expensive: 350 to 56,700 microseconds, scaling badly with region size. The NIC firmware has to update page tables, and that's a control-plane bottleneck.

QP access flag changes are much faster at about 88 microseconds, but they can trigger an error state if RDMA operations are in flight when you modify the flags.

QP state cycling, transitioning through RESET and back to RTS, is robust regardless of in-flight operations but costs about 1,216 microseconds.

Mu uses a fast-then-slow strategy: try the fast QP flag change first. If it errors because operations were in flight, fall back to the robust QP state cycle.

This isn't just an implementation detail. It's part of the paper's broader point: microsecond SMR hits hardware control-plane costs that traditional systems never worried about. The fast path runs in microseconds, but leader changes are bounded by what NIC firmware and driver stacks are optimized for.

---

## Slide 24 — Part III: Evaluation (Section Divider)

Let's look at how Mu performs in practice. The evaluation uses a four-node cluster with 100 Gbps InfiniBand, dual Xeon E5-2640 v4 CPUs, Ubuntu 18.04, and Mellanox OFED drivers. They evaluate three-way replication.

---

## Slide 25 — Replication Latency

The headline result: about 1.3 microseconds median replication latency for small in-memory requests, with about 1.6 microseconds at the 99th percentile.

For payloads up to the RDMA inline threshold, 256 bytes in their setup, latency is roughly flat. Inlined RDMA avoids the extra DMA step of fetching the payload from host memory. Past 256 bytes, latency rises gradually.

Compared to the baselines (Hermes, DARE, APUS), Mu is faster by multiples in the median and has much tighter tail latency. The paper attributes the competitors' longer tails to two things: involving follower CPUs in the critical path, and serializing multiple RDMA operations whose timing variances compound.

---

## Slide 26 — Standalone vs. Attached Performance

This figure compares standalone mode, where Mu tight-loops in isolation, versus attached mode, where it's integrated with a real application. Attached mode adds cache and scheduling interference.

They also compare dedicated-core versus shared-core configurations. Sharing a core incurs about 400 nanoseconds of cache-coherence penalty per request.

The takeaway: at microsecond scale, thread and core topology is a first-order design choice. A fast algorithm isn't enough. You also need to think about where threads are pinned and how cache lines bounce between cores.

---

## Slide 27 — End-to-End Application Latency

This is the more meaningful question: how does replication overhead compare to the application's own work?

Mu plugs in through its capture-and-inject shim. Liquibook, a financial exchange matching engine, goes from 4.08 microseconds unreplicated to 5.55 microseconds with Mu. That's roughly 35% overhead. HERD, an RDMA key-value store, goes from 2.25 to 3.59 microseconds.

For TCP-based systems like Redis and Memcached, the base latency is around 115 microseconds, so Mu's extra 1.5 microseconds basically vanishes in the noise.

The paper's message is clear: for true microsecond applications like Liquibook and HERD, even 1.3 microseconds is a meaningful fraction of total latency. But Mu is the only system in the comparison where that overhead is plausibly acceptable. Every other system adds enough that replication becomes a non-starter for these workloads.

---

## Slide 28 — Failover Performance

Mu reports 873 microseconds median failover time. That's sub-millisecond, and orders of magnitude faster than traditional SMR failover, which typically takes tens to hundreds of milliseconds.

The experiment injects failure by delaying the leader until it becomes unresponsive, triggering pull-score suspicion at the followers. The paper breaks down detection time versus permission switch time, and confirms that the permission switch dominates. That's consistent with the hardware numbers we saw earlier.

The histogram shows failover times are tightly clustered. The system behaves predictably under failure rather than exhibiting a long tail of recovery times.

---

## Slide 29 — Latency vs. Throughput

This figure shows latency versus throughput. Mu maintains low latency as throughput increases, comparing well against the baselines across both dimensions.

The key observation: Mu doesn't sacrifice throughput for low latency. It scales reasonably under increasing load. The baselines that involve follower CPUs in the critical path show steeper latency degradation as load grows.

---

## Slide 30 — What Mu Achieves

Let's step back and summarize what Mu achieves.

About 1.3 microseconds median replication latency. 873 microseconds median failover. Both are the best numbers in the comparison.

In the common case, it's near the RDMA lower bound: one round of one-sided writes. That's essentially the minimum you can do while still getting majority replication.

It provides linearizability through hardware-enforced single-writer permissions, not through protocol-level quorum responses.

It integrates with real applications: Liquibook, HERD, Redis, Memcached. This isn't a simulation or a theoretical exercise.

And it's complete SMR. Leader change, log recycling, catch-up. Not a fast-path demo, but a system that handles the full lifecycle of replication.

---

## Slide 31 — Limitations & Open Questions

The paper is upfront about its limitations.

RDMA is required. This targets datacenter and LAN environments with InfiniBand or RoCE. Not applicable to WAN.

It's in-memory only. No durable logging to stable storage. The paper mentions persistent memory as a future direction.

Permission switching costs hundreds of microseconds on current NICs. The fast-slow QP strategy helps, but the fundamental cost is a hardware control-plane bottleneck.

The canary byte scheme relies on certain NIC and NUMA placement conditions for left-to-right visibility ordering. The paper sketches a checksum alternative for robustness across hardware, but that adds cost.

The broader point: Mu shifts work from the network data plane to the RDMA control plane. The fast path is microseconds, but the slow path is bounded by what NIC firmware and drivers are optimized for today.

---

## Slide 32 — The Bigger Picture

Where does Mu sit in the bigger picture?

The key contribution is conceptual: treating RDMA's access control as a distributed systems primitive. Not just using RDMA as faster transport, but using its permission model as the core mechanism for preventing split-brain. Others had explored RDMA for replication before, but Mu pushes the idea all the way into a complete SMR system with leader change, log recycling, and real application integration.

Pull-score is also worth highlighting. It confronts a practical truth: microsecond failover is usually dominated by jitter sensitivity, not algorithmic complexity. Polling a counter over RDMA changes how delay manifests, which lets you lower detection thresholds without constant false elections.

The field kept moving after Mu. Acuerdo at ICPP 2022 optimized quorum behavior for RDMA-based atomic broadcast. NetLR at VLDB 2022 explored in-network replication. Nezha at VLDB 2023 tackled deployability and performance tradeoffs. OSDI 2023 work addressed the durability gap with persistent-memory replication over RDMA.

The most honest summary: Mu demonstrates that near-microsecond SMR is feasible when you exploit one-sided RDMA for the fast path and use RDMA permissions for safety. But it also exposes the next set of bottlenecks: permission-switch control-plane costs, durability, and deployment beyond RDMA-equipped datacenters.

Thank you.
