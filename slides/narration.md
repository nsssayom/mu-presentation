# Mu Presentation — Slide-by-Slide Narration

A lossless walkthrough of "Microsecond Consensus for Microsecond Applications" (OSDI 2020).
Each section below corresponds to one slide. Deliver at a natural pace; the full narration runs approximately 35–40 minutes.

---

## Slide 1 — Title

This is Mu — spelled with the Greek letter μ — from OSDI 2020. The paper is by Marcos Aguilera, Naama Ben-David, Rachid Guerraoui, Virendra Marathe, Athanasios Xygkis, and Igor Zablotchi.

The title tells you the ambition: microsecond consensus for microsecond applications. By the end of this talk you will understand exactly what that means, why it is hard, and how Mu achieves it.

---

## Slide 2 — The Problem

Here is the problem in one sentence: modern applications do useful work in a few microseconds, but the standard way we make distributed services fault-tolerant — state machine replication — historically adds tens to hundreds of microseconds of replication overhead and tens to hundreds of milliseconds of failover time.

At microsecond scale, those overheads are not just "overheads" anymore. They *are* the entire latency budget. If your application completes in four microseconds and replication adds another fifty, replication has become twelve times the cost of the actual work.

The paper's central claim is: you cannot merely shave cycles off existing protocols. You need a fundamentally different lever.

---

## Slide 3 — Where Microseconds Matter

Why should we care about microsecond replication? The paper grounds the motivation in three concrete domains.

First, financial trading. Microseconds literally equal money. If your replicated matching engine adds several microseconds of latency, that is a direct competitive disadvantage — other firms will see price changes and act before you do.

Second, embedded control systems. Microseconds equal safety. Real-time control loops — think autonomous systems or industrial controllers — demand ultra-low-latency replication if they are going to be fault-tolerant at all.

Third, microservices. In large service graphs, latency compounds. If every stateful component on the critical path — key-value stores, coordination services — adds replication overhead, the total round-trip latency grows multiplicatively.

The takeaway: if replication adds several microseconds or failover takes milliseconds, it becomes either a competitive disadvantage or something dismissed as an unavoidable cost of doing business.

---

## Slide 4 — State Machine Replication (SMR)

Before we get to Mu's solution, we need two pieces of background. The first is state machine replication.

SMR is the gold standard for making a distributed service behave as if there were a single, reliable copy. Each replica keeps a copy of the application and a log of client requests. The leader orders requests, replicates them to a majority of replicas, and replicas apply log entries in order. If the application is deterministic, all replicas stay identical.

Why a majority? Because with crash faults, any two majorities intersect in at least one replica. That intersection is what prevents two different values from both being considered "committed" for the same log slot. This is the core mechanism that gives you linearizability — the guarantee that the replicated service behaves as one copy and every operation takes effect at one instant between call and return.

Classic Paxos achieves this with increasing proposal numbers and a two-phase protocol: prepare, then accept, with follower responses on the critical path. Each of those steps costs microseconds. Mu's question is: can we do better?

---

## Slide 5 — RDMA: The Lever

The second piece of background is RDMA — Remote Direct Memory Access. This is Mu's lever.

RDMA exposes one-sided operations — Write and Read — that can complete without the remote CPU actively running any receive code. The NIC handles the data transfer directly into or out of registered memory. That is why RDMA can be extremely low-latency and low-jitter when used carefully.

But RDMA is not "magic shared memory." It has a protection model. Two objects matter for understanding Mu:

A Memory Region, or MR, is registered user memory that the NIC is allowed to access. It carries access flags — you can configure whether remote reads or remote writes are permitted.

A Queue Pair, or QP, is the endpoint over which RDMA work requests are posted. It also carries access flags and goes through a state machine: RESET, INIT, RTR, RTS. Mu uses Reliable Connection transport, which gives reliable, in-order delivery between a connected pair of QPs.

The critical insight for Mu is that permissions are hardware-enforced. You can structure RDMA so that a given remote peer is allowed to write only if its QP and the MR permissions both allow it — and you can change those permissions dynamically. A remote RDMA write either succeeds or fails based on the current permission state. That hardware enforcement is what Mu will exploit.

---

## Slide 6 — Mu's Two Core Ideas

Mu introduces two ideas that work together.

First: silent followers. In the common case, Mu's leader replicates by directly writing the request into each follower's log using one-sided RDMA writes. Followers do zero network communication on the fast path. They do not send acknowledgments, they do not participate in the critical path at all. The paper argues this reaches the practical lower bound of what current RDMA hardware can do for replication latency — essentially one "one-sided round."

Second: permission equals safety. Mu makes "who can write a replica's log" an explicit invariant. Each replica grants RDMA write permission to its log to exactly one leader at a time. So the way Mu prevents two leaders from racing is not primarily through proposal numbers and follower replies as in classic Paxos, but through hardware access control: a competing leader's writes literally fail because it does not have permission. The NIC rejects the write at the hardware level.

These two ideas together are what make microsecond replication possible while maintaining safety.

---

## Slide 7 — Two-Plane Architecture

This figure shows Mu's architecture. The system is split into two planes that run on separate threads and even separate QPs and MRs for isolation.

The replication plane — the fast path — is obsessed with making the common case fast. It handles only the steady-state loop: receive request, write to follower logs, commit, respond.

The background plane handles everything else: failure detection, leader election, permission management, and catch-up. These are all operations that can tolerate higher latency because they happen infrequently — only when something goes wrong or a new replica needs to synchronize.

The key point of the architecture diagram is that these two planes are isolated by design. The replication plane never blocks on background-plane operations, and vice versa.

---

## Slide 8 — The Background Plane

Let me elaborate on the background plane, because understanding what it does is essential for following the rest of the talk.

The background plane has four responsibilities. First, failure detection — it runs pull-score heartbeat monitoring using RDMA reads, which we will discuss in detail later. Second, leader election — a deterministic rule where the leader is the lowest-ID replica considered alive. Third, permission management — the revoke-and-grant protocol for RDMA write access during leader transitions. And fourth, catch-up and recovery — synchronizing lagging or recovering replicas.

Why does it need to be separate? Because background work must never block the fast-path replication thread. If a permission change or a catch-up operation caused the replication thread to stall, you would lose the microsecond latency guarantee. Separate QPs prevent control-plane RDMA operations from queuing behind data-plane writes. Separate MRs prevent permission changes on the background region from disrupting replication MR access.

This isolation is not just an optimization — it is a correctness requirement at microsecond scale.

---

## Slide 9 — Part I: Normal Operation (Section Divider)

Now let us walk through how Mu actually works, starting with the normal case — the fast path when everyone agrees on who the leader is.

---

## Slide 10 — The Fast Path

Imagine a system with three replicas. One replica is the leader, and all replicas agree on that. Each replica has granted RDMA write permission on its own log to the current leader and to nobody else.

A client request arrives at the leader. Mu uses a small "capture and inject" shim — a thin layer that intercepts requests before they reach the application so they can be replicated, and later injects them into each replica's application for deterministic replay. The request is treated as a black-box byte sequence.

Now the replication plane executes the fast path: the leader appends the request to the next log slot, then replicates it by issuing RDMA writes to each follower's log. These are one-sided writes — the follower CPUs are not involved. Once the leader knows the request is replicated on a majority — which for three replicas means any two of three — it can execute the request and respond to the client. Followers later independently observe the new entry in their own local log memory and replay it.

The callout here is important: this reaches the practical lower bound of what RDMA hardware can do for replication. It is one round of one-sided writes. You cannot do less and still have a majority acknowledge.

---

## Slide 11 — Replication in Action (Animation)

Let me walk through this step by step with the animation.

*[Click 1]* The client sends a request to the leader.

*[Click 2]* The leader appends the entry to its local log — you can see "v₁" appearing in the first log slot.

*[Click 3]* Now the key step: the leader issues one-sided RDMA writes to both followers' logs simultaneously. Notice the dashed blue lines — these are RDMA writes flowing through the network. Crucially, look at the follower CPUs: they are marked "CPU idle — not involved." The NIC is handling the memory write directly; the follower's CPU does not execute any code for this operation.

*[Click 4]* Both followers now have v₁ in their logs. The leader has replicated the entry on a majority — all three replicas have it. The entry is committed. The total time: approximately 1.3 microseconds.

*[Click 5]* The leader executes the request and sends the response back to the client.

*[Click 6]* Finally, the followers independently discover the new entry in their logs and replay it through their local application copy. This happens asynchronously — it is not on the critical path.

So in the happy case, Mu is: leader writes into follower logs, followers locally replay, everyone stays in sync, and no follower network chatter is on the critical path.

---

## Slide 12 — Per-Replica Data Structures

Each replica maintains several data structures. The log itself is a registered Memory Region, writable only by the current leader via RDMA.

The First Undecided Offset, or FUO, is the lowest log index the replica believes is undecided. In steady state, FUO advances as slots become decided and applied.

Each log slot contains a tuple: a proposal number and a value.

And at the end of each entry is a canary byte — a mechanism we will discuss next that prevents reading half-written RDMA entries.

---

## Slide 13 — Making It Actually Correct

Four subtle details make the fast path actually correct.

First, the canary byte. RDMA writes are not transactional — a follower could observe a partially written log entry if it reads while the leader is writing. Mu uses a standard trick: the leader sets a canary byte at the end of each entry to a non-zero value when writing. The follower checks this canary before trusting the entry. In practice, certain NIC and NUMA placement conditions give a left-to-right visibility effect, so the canary at the end is the last thing to become visible. The paper notes that you could make the canary a checksum to be robust against ordering anomalies across different hardware.

Second, commit piggybacking. In Paxos, learners get an explicit "chosen" signal. Mu avoids that extra communication. Because the leader only moves forward once earlier slots are decided, followers can treat the highest contiguous non-empty prefix of the log as committed, except possibly the last entry. In effect, the next write serves as the commit signal for the previous slot.

Third, log recycling. The log is circular and reuses entries once all replicas have applied them. We will see the details of how this works — minHead computation and zeroing — when we discuss catch-up.

Fourth, prepare omission. This is the key performance optimization. Once a leader observes only empty slots at some FUO across its confirmed followers, it can omit the prepare phase for all subsequent indices until it aborts. So the common-case cost of proposing becomes just the one-sided RDMA writes of the accept step. That is how Mu gets down to one round.

---

## Slide 14 — Part II: Safety & Leader Change (Section Divider)

Now for the hard part. The normal case is elegant, but the hardest part of consensus is not the normal case when everyone agrees on the leader. It is preventing split-brain and races between concurrent leaders during failure suspicion, network jitter, or delayed scheduling. This section covers everything from how Mu prevents concurrent leaders to how it detects failures, changes leaders, handles edge cases, and recovers.

---

## Slide 15 — Why Concurrent Leaders Are Dangerous

Why do concurrent leaders matter? In classic SMR, if a leader appears slow or dead, some other replica will try to take over. Now you have two replicas that both think they are leader, potentially writing different values to the same log slot. This is the split-brain problem.

The classic approach handles this with extra message rounds and follower promises: "I won't accept proposals with a number lower than yours." Each round adds more microseconds to the critical path.

Mu's approach is fundamentally different. Instead of making followers promise, Mu makes unauthorized writes physically impossible. It is not "the follower promises not to accept" — it is "the NIC rejects the write because the QP or MR does not have the required permission flags set." Safety via hardware access control.

The callout underscores the point: the hardest part of consensus is not the normal case. It is preventing races during failure suspicion, network jitter, or delayed scheduling. That is exactly where Mu spends its novelty budget.

---

## Slide 16 — Permission-Based Safety

Here is how Mu's permission system works in detail.

The invariant is simple: each replica grants RDMA write permission on its log to exactly one leader at a time. This is hardware-enforced — unauthorized RDMA writes silently fail at the NIC. No error propagates to the writer; the data simply does not land.

When permissions need to change — say, during a leader transition — a would-be leader writes a permission request into the target replica's background-plane Memory Region. This is itself a one-sided RDMA write into a permission request array that each replica maintains. The log owner's background thread detects the request, revokes write access from the current holder by modifying QP or MR flags, then grants write access to the requester. If multiple replicas request permission simultaneously, they are processed one by one, ordered by replica ID. This deterministic ordering prevents races between competing candidates.

Only after the revoke-and-grant cycle completes does the replica join the new leader's "confirmed followers" set — a concept we will see next. The old leader's in-flight RDMA writes silently fail after revocation. They simply do not land.

The permission switch itself turns out to be the dominant cost of failover — hundreds of microseconds on current NICs. We will see the exact numbers later. But the key conceptual point is: this replaces Paxos proposal numbers with hardware access control. Safety is enforced by the NIC, not by protocol messages.

---

## Slide 17 — Confirmed Followers & The Protocol

Now, the consensus protocol itself. Mu introduces a leader-maintained set called "confirmed followers." This set contains replicas that have granted exclusive write permission to this leader and revoked it from everyone else. Membership means something stronger than "they replied to a message." It means: those replicas' NIC permissions guarantee no other leader can concurrently write their logs.

Mu's propose operation resembles Paxos conceptually, but with a major twist — the leader directly reads and writes follower state through RDMA, treating follower memory as published state.

The prepare-like step: RDMA-read the minimum proposal number from confirmed followers, pick a higher proposal number, write it back, and read the slot at FUO.

The accept-like step: RDMA-write the proposal number and value into the FUO slot on confirmed followers.

But the crucial safety condition is not "followers responded and promised." It is: I only touch replicas whose permissions guarantee no other leader can write them while I operate.

Then the key optimization: once a leader observes only empty slots at some FUO across confirmed followers, it omits the prepare phase for subsequent indices. This is why the common-case cost is just one round of one-sided RDMA writes.

---

## Slide 18 — Pull-Score Failure Detection

How does Mu detect that a leader has failed? This is where the background plane's failure detection mechanism comes in.

In traditional push-based heartbeats, the leader periodically sends heartbeat messages. But network jitter can delay those messages, so timeouts must be set conservatively large to avoid false positives. At microsecond scale, that means either you tolerate long detection delays or you suffer constant false leader changes.

Mu uses a pull-based approach. Each replica maintains a local heartbeat counter and increments it as it makes progress. Other replicas periodically RDMA-read that counter. If the read observes progress since last time — meaning the counter changed — the score decreases. If the counter has not changed — potentially indicating a stall — the score increases. Scores are bounded between 0 and 15, with a failure threshold at 2 and a recovery threshold at 6.

The key subtlety is why this helps microsecond failover. In push heartbeats, network delay causes a sudden silent gap that must be disambiguated from actual failure. In pull-score, network delay slows down the rate of "same value" observations rather than causing a sudden gap. That lets you set aggressive thresholds without spurious leader changes under typical datacenter conditions.

The system also has a two-layer design: the small pull-score threshold handles common failures like brief stalls or scheduling delays, while a longer connection-level timeout handles bigger disruptions like network breakage or machine crashes. Hysteresis between the failure and recovery thresholds prevents oscillation.

---

## Slide 19 — Leader Election & Fate Sharing

Leader election in Mu is intentionally simple in policy but careful in mechanism.

The policy: each replica decides locally that the leader is the lowest-ID replica it currently considers alive. There is no explicit voting protocol — the point is to make leader choice deterministic given a set of "alive" nodes. If everyone agrees on who is alive, they agree on the leader.

The mechanism requires a practical detail called fate sharing. Because replication and leader election run on separate threads, you could get a pathological case where the election thread is healthy — it is running, the replica appears alive — but the replication thread is stuck. Maybe it hit a bug, maybe it is blocked on a lock. The result: progress is blocked, but no leader change happens because the leader still appears alive to the failure detector.

Mu addresses this by having the election thread periodically check replication activity. If replication appears stuck, the leader's election thread stops incrementing its heartbeat counter, which will cause other replicas to replace it.

This is a very practical example of the paper's mindset: the correctness model is distributed algorithms, but microsecond behavior is often dominated by engineering pathologies, not algorithmic complexity. Fate sharing is a practical fix for a real systems problem.

---

## Slide 20 — Leader Change Process

When a leader is suspected failed, the leader change process unfolds in five steps.

Step one: the pull-score failure detector triggers, and the local leader rule activates. The next replica in line — the lowest-ID replica still considered alive — starts behaving as the new leader.

Step two: the new leader requests permissions from each replica via the background plane, writing into their permission request arrays.

Step three: each replica's background thread processes the request — revoking write access from the old leader and granting it to the new one.

Step four: the new leader catches up. It reads the FUO from each confirmed follower and copies missing entries from the most advanced follower — the one with the highest FUO.

Step five: the new leader updates lagging replicas by pushing missing log segments to them and aligning their FUOs.

The figure on the right shows this process visually.

---

## Slide 21 — Edge Cases During Leader Change

Leader change sounds straightforward, but several edge cases can arise.

First: the old leader might still be alive. Maybe it was just temporarily slow, or the failure suspicion was premature. It might try to write after being suspected. This is safe because its RDMA writes silently fail once permissions have been revoked — the NIC rejects them.

Second: competing candidates. Multiple replicas might suspect the leader simultaneously and all try to become the new leader. The permission manager handles this by processing requests one by one, ordered by replica ID. This deterministic ordering ensures exactly one candidate wins.

Third: partially replicated entries. The old leader might have written an entry to some followers but not a majority before losing permission. The new leader's prepare phase discovers these by RDMA-reading the slot state from confirmed followers. It can then complete or override the partial proposal.

Why does all of this stay safe? Because the confirmed followers set means exactly what it says: those replicas have revoked the old leader and granted the new one. The new leader only operates on confirmed followers, so it is guaranteed there is no concurrent writer. The prepare phase reads slot state to recover any in-flight proposals before proceeding.

The crucial point: safety does not rely on timing or promises. It is enforced by hardware permission state at the NIC level.

---

## Slide 22 — Catch-Up & Log Recovery

Catch-up and log recovery are what make Mu a complete SMR system rather than just a fast common-case trick.

When a new leader takes over, it needs to ensure all replicas are consistent. The catch-up process has three steps: RDMA-read the FUO from each confirmed follower, copy missing entries from the most advanced follower — the one with the highest FUO — and then push missing entries to lagging followers and align their FUOs. Without this, any replica that was not in the confirmed set would drift forever.

On the right side, we have circular log recycling, which keeps the log finite. Each follower tracks a log-head pointer — the first entry not yet applied to its local application copy. The leader periodically RDMA-reads all followers' head pointers and computes minHead — the minimum across all followers. Entries below minHead have been applied by every replica and can safely be zeroed and reused.

The zeroing step is critical and not just a cleanup detail. The canary byte mechanism relies on empty entries being distinguishable from written ones. If you reuse a log slot without zeroing it, a follower might mistake the stale canary byte from a previous entry for a fresh write. Zeroing ensures that when a follower sees a non-zero canary, it can trust that the entry was freshly written by the current leader.

---

## Slide 23 — Permission Switch Mechanisms

Now we get to something the paper discovered is a surprising bottleneck: the cost of changing RDMA permissions.

Ordinary RDMA read and write operations complete in low single-digit microseconds. But changing the permissions — the operation that enables safe leader transitions — is far slower.

The paper evaluates three mechanisms. Re-registering Memory Regions with different access flags is the most flexible but also the most expensive: 350 to 56,700 microseconds, scaling disastrously with region size. This is a NIC control-plane bottleneck — the firmware has to update page tables.

Changing QP Access Flags is much faster at about 88 microseconds, but it can trigger an error state if RDMA operations are in flight when you modify the flags.

Cycling QP States — transitioning the QP through RESET and back to RTS — is slower at about 1,216 microseconds but is robust regardless of in-flight operations.

Mu uses a fast-slow strategy: try the fast QP access flag change first, and if it triggers errors because operations were in flight, fall back to the robust QP state cycle approach.

This is not just an implementation trick. It is part of the paper's broader message: microsecond SMR hits hardware control-plane costs that traditional systems never cared about. The fast path is microseconds, but the leader change path is bounded by what NIC firmware and driver stacks optimize for — which today means hundreds of microseconds for permission changes.

---

## Slide 24 — Part III: Evaluation (Section Divider)

Now let us see how Mu performs in practice. The evaluation runs on a four-node cluster with 100 Gbps InfiniBand, dual Xeon E5-2640 v4 CPUs, Ubuntu 18.04, and Mellanox OFED drivers. They evaluate three-way replication — the typical configuration.

---

## Slide 25 — Replication Latency

The headline result: approximately 1.3 microseconds median replication latency for a small in-memory request, with approximately 1.6 microseconds at the 99th percentile.

This figure shows that for small payloads up to the RDMA inline threshold — 256 bytes in their setup — latency is roughly flat, because inlined RDMA avoids the extra DMA step of fetching payloads from host memory. Past 256 bytes, latency rises gradually.

Compared to the baselines — Hermes, DARE, and APUS — Mu is faster by multiples in median and has a much tighter tail latency. The paper attributes competitors' longer tails to involving follower CPUs in the critical path and to serializing multiple RDMA events whose timing variances add up.

---

## Slide 26 — Standalone vs. Attached Performance

This figure compares standalone mode — where Mu tight-loops in isolation — versus attached mode, where Mu is integrated with a real application. Attached mode adds cache and scheduling interference.

They also compare two attached configurations: dedicated cores for app and replication versus shared-core mode. The shared-core configuration incurs a cache-coherence miss penalty of about 400 nanoseconds per request.

This is important because it tells you that at microsecond scale, thread and core topology becomes a first-order design choice. It is not enough to have a fast algorithm — you also need to think about where your threads are pinned and how cache lines bounce between cores.

---

## Slide 27 — End-to-End Application Latency

This is the more meaningful question: how does replication overhead compare to the application's own work?

Mu integrates with applications through its capture-and-inject shim. For Liquibook, a financial exchange matching engine, unreplicated median latency is about 4.08 microseconds and replicated with Mu it is about 5.55 microseconds — roughly 35% overhead. For HERD, an RDMA key-value store, unreplicated is about 2.25 microseconds and replicated is about 3.59 microseconds.

For TCP-based systems like Redis and Memcached, end-to-end latencies are around 115 microseconds unreplicated, so the extra 1.5 microseconds from Mu is basically negligible — it disappears in the noise.

The paper's interpretation is clear: for true microsecond applications like Liquibook and HERD, even 1.3 microseconds of replication overhead is a significant percentage of total latency. But Mu is the only compared system where that overhead is plausibly acceptable. Every other system adds enough latency to make replication a non-starter for these applications.

---

## Slide 28 — Failover Performance

Mu reports 873 microseconds median failover time — sub-millisecond. This is orders of magnitude faster than traditional SMR failover, which typically takes tens to hundreds of milliseconds.

The failover experiment injects failure by delaying the leader so it becomes temporarily unresponsive, which triggers pull-score suspicion at the followers. The paper explicitly separates detection time from permission switch time in their analysis, confirming that the permission switch is the dominant cost center — consistent with the hardware numbers we saw earlier.

The histogram shows that failover times are tightly clustered, meaning the system behaves predictably under failure rather than exhibiting a long tail of recovery times.

---

## Slide 29 — Latency vs. Throughput

This figure shows how Mu behaves as throughput increases. Mu maintains low latency under increasing load, comparing favorably against baseline systems across both dimensions.

The important observation is that Mu does not sacrifice throughput for its low latency — the system scales reasonably as you push more requests through it. The baselines that involve follower CPUs in the critical path tend to show steeper latency degradation under load.

---

## Slide 30 — What Mu Achieves

Let us summarize what Mu achieves concretely.

Approximately 1.3 microseconds median replication latency. 873 microseconds median failover time — sub-millisecond.

Near the RDMA lower bound in the common case — one round of one-sided writes is essentially the minimum you can do and still have majority replication.

Strong consistency — Mu targets linearizability, achieved through hardware-enforced single-writer permissions rather than protocol-level quorum responses.

Real application integration — not a theoretical exercise but a system that runs with Liquibook, HERD, Redis, and Memcached.

And complete SMR — leader change, log recycling, catch-up. This is not just a fast-path trick. It handles the full lifecycle of a replicated system.

---

## Slide 31 — Limitations & Open Questions

The paper is explicit about its limitations.

First, RDMA is required. This targets datacenter or LAN environments with RDMA fabric — InfiniBand or RoCE. It is not applicable to WAN deployments.

Second, it is in-memory replication only. There is no durable logging to stable storage. The paper mentions persistent memory support as a possible future direction.

Third, permission switching costs hundreds of microseconds on current NICs. The paper does engineering tricks — the fast-slow QP strategy — but the fundamental cost is a hardware control-plane bottleneck.

Fourth, there are hardware assumptions. The canary byte scheme relies on certain NIC and NUMA placement conditions to get left-to-right visibility ordering. The paper acknowledges this and sketches a robust alternative using checksums, but that adds cost and complexity.

The broader point: Mu shifts work from the network data plane to the RDMA control plane. The fast path is microseconds — but the slow path remains bounded by what NIC firmware and drivers optimize for today.

---

## Slide 32 — The Bigger Picture

Where does Mu sit in the broader landscape?

The key contribution is conceptual: treating RDMA's access control as a distributed systems primitive — not just using RDMA as a faster message transport, but using its permission model as the core split-brain prevention mechanism. That lines up with earlier ideas in the RDMA systems community, but Mu pushes it all the way into a complete SMR design with leader change, log recycling, and real application integrations.

The pull-score mechanism is also worth highlighting because it directly confronts a practical truth: microsecond failover is often dominated by jitter sensitivity, not by algorithmic complexity. Polling a memory counter over RDMA changes how delay manifests, which lets you lower timeouts without triggering constant false elections.

After Mu, the field continued to evolve. Acuerdo at ICPP 2022 optimized waiting and quorum behavior for RDMA-based atomic broadcast. NetLR at VLDB 2022 explored in-network replication, positioning against both RDMA-based and in-switch baselines. Nezha at VLDB 2023 tackled deployability and performance tradeoffs. And OSDI 2023 work on replicating persistent-memory key-value stores with RDMA addresses the durability gap.

So the most accurate way to place Mu today: it demonstrates that near-microsecond SMR is feasible when you exploit one-sided RDMA for the fast path and use RDMA permissions as the core safety mechanism. But it also exposes the next bottlenecks — permission-switch control-plane costs, the question of durability, and broader deployment models beyond RDMA-equipped datacenters.

Thank you.
