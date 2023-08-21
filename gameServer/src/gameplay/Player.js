import { WebSocketConnection } from "../WebSocketConnection.js";
import {
	MIN_TILES_VIEWPORT_RECT_SIZE,
	PLAYER_TRAVEL_SPEED,
	SKINS_COUNT,
	UPDATES_VIEWPORT_RECT_SIZE,
	VIEWPORT_EDGE_CHUNK_SIZE,
} from "../config.js";
import { Vec2 } from "renda";
import { checkTrailSegment } from "../util/util.js";

/**
 * When sent inside messages, these translate to an integer:
 * - right - 0
 * - down - 1
 * - left - 2
 * - up - 3
 * - paused - 4
 * @typedef {"right" | "down" | "left" | "up" | "paused"} Direction
 */

/** @typedef {"player" | "area-bounds" | "self"} DeathType */

export class Player {
	#id;
	#game;
	#connection;
	#skinId = 2;

	#currentTileType = 0;

	/**
	 * The current position of the player, rounded to the coordinate of the current tile.
	 */
	#currentPosition = new Vec2(20, 20);

	/**
	 * Returns the current position of the player, rounded to the coordinate of the current tile.
	 */
	getPosition() {
		return this.#currentPosition.clone();
	}

	/**
	 * The X position of the player when the most recent horizontal edge chunk was sent to the client.
	 * If the player moves too far away from this position, a new edge chunk will be sent.
	 */
	#lastEdgeChunkSendX = 20;

	/**
	 * The Y position of the player when the most recent vertical edge chunk was sent to the client.
	 * If the player moves too far away from this position, a new edge chunk will be sent.
	 */
	#lastEdgeChunkSendY = 20;

	/**
	 * Indicates how many tiles the player has moved on the client side.
	 * Any value below 1 means the player is still on its current tile.
	 * Any value above 1 means the player has travelled that many tiles, each of which should
	 * be checked for updates to their trail etc.
	 */
	#nextTileProgress = 0;

	/** @type {Direction} */
	#currentDirection = "up";

	get currentDirection() {
		return this.#currentDirection;
	}

	/** @type {Vec2[]} */
	#trailVertices = [];

	get isGeneratingTrail() {
		return this.#trailVertices.length > 0;
	}

	/**
	 * The bounding box of the current trail, used for hit detection with other players.
	 * @type {import("../util/util.js").Rect}
	 */
	#trailBounds = {
		min: new Vec2(),
		max: new Vec2(),
	};

	/**
	 * @typedef MovementQueueItem
	 * @property {Direction} direction The direction in which the player started moving.
	 * @property {Vec2} desiredPosition The location at which the player wishes to start moving. If the player
	 * has already moved past this point, we could also move them back in time in order to fulfill their request.
	 */

	/** @type {MovementQueueItem[]} */
	#movementQueue = [];

	/**
	 * @typedef DeathState
	 * @property {number} dieTime
	 * @property {DeathType} type
	 */

	/** @type {DeathState?} */
	#lastDeathState = null;
	get dead() {
		return Boolean(this.#lastDeathState);
	}

	#permanentlyDead = false;
	#permanentlyDieTime = 0;

	/**
	 * @param {number} id
	 * @param {import("./Game.js").Game} game
	 * @param {WebSocketConnection} connection
	 */
	constructor(id, game, connection) {
		this.#id = id;
		this.#game = game;
		this.#connection = connection;
		game.arena.fillPlayerSpawn(this.#currentPosition, id);
	}

	get id() {
		return this.#id;
	}

	get game() {
		return this.#game;
	}

	get connection() {
		return this.#connection;
	}

	get skinId() {
		return this.#skinId;
	}

	/**
	 * Returns a rect defining the area for which events should be sent to this player.
	 * @returns {import("../util/util.js").Rect}
	 */
	getUpdatesViewport() {
		return {
			min: this.#currentPosition.clone().addScalar(-UPDATES_VIEWPORT_RECT_SIZE),
			max: this.#currentPosition.clone().addScalar(UPDATES_VIEWPORT_RECT_SIZE),
		};
	}

	/**
	 * The client requested a new position and direction for its player.
	 * The request will be added to a queue and might not immediately get parsed.
	 * @param {Direction} direction
	 * @param {Vec2} desiredPosition
	 */
	clientPosUpdateRequested(direction, desiredPosition) {
		this.#movementQueue.push({
			direction,
			desiredPosition,
		});
		this.#drainMovementQueue();
	}

	/**
	 * Tries to empty the movement queue until an item is encountered for which the player hasn't reached its location yet.
	 */
	#drainMovementQueue() {
		while (true) {
			if (this.#movementQueue.length <= 0) return;
			const firstItem = this.#movementQueue[0];
			const valid = this.#checkNextMoveValidity(firstItem.desiredPosition, firstItem.direction);
			if (!valid) {
				this.#movementQueue.shift();
				continue;
			}

			this.#movementQueue.shift();
			this.#currentPosition.set(firstItem.desiredPosition);
			if (this.isGeneratingTrail) {
				this.#trailVertices.push(firstItem.desiredPosition.clone());
			}
			this.#currentDirection = firstItem.direction;
			this.game.broadcastPlayerState(this);
		}
	}

	/**
	 * Checks if this is a valid next move, and if not, returns the reason why it's invalid.
	 * @param {Vec2} desiredPosition
	 * @param {Direction} newDirection
	 */
	#checkNextMoveValidity(desiredPosition, newDirection) {
		// If the player is already moving in the same or opposite direction
		if (
			(this.#currentDirection == "right" || this.#currentDirection == "left") &&
			(newDirection == "right" || newDirection == "left")
		) {
			return false;
		}
		if (
			(this.#currentDirection == "up" || this.#currentDirection == "down") &&
			(newDirection == "up" || newDirection == "down")
		) {
			return false;
		}
		if (this.#currentDirection == newDirection) return false;

		// Pausing should always be allowed, if the provided position is invalid
		// it will be adjusted later
		if (newDirection == "paused") return true;

		// Finally we'll make sure the desiredPosition is aligned with the current direction of movement
		if (this.#currentDirection == "left" || this.#currentDirection == "right") {
			if (desiredPosition.y != this.#currentPosition.y) return false;
		}
		if (this.#currentDirection == "up" || this.#currentDirection == "down") {
			if (desiredPosition.x != this.#currentPosition.x) return false;
		}

		return true;
	}

	/**
	 * Returns an integer that a client can use to render the correct color for a player or tile.
	 * When two players have the same color, a different integer is returned to make sure a
	 * player doesn't see any players with their own color.
	 * The returned value ranges from 0 to (SKINS_COUNT - 1).
	 * @param {Player} otherPlayer
	 */
	skinIdForPlayer(otherPlayer) {
		if (this.#skinId != otherPlayer.skinId || otherPlayer == this) {
			return this.#skinId;
		} else {
			// The color of this player is the same as my color, we'll generate a random color (that is not mine)
			let fakeSkinId = this.id % (SKINS_COUNT - 1); //ranges from 0 to (SKINS_COUNT - 2)
			if (fakeSkinId >= otherPlayer.skinId - 1) {
				fakeSkinId++; //make the value range from 0 to (SKINS_COUNT - 1) but exclude otherPlayer.skinId
			}
			return fakeSkinId;
		}
	}

	*getTrailVertices() {
		for (const vertex of this.#trailVertices) {
			yield vertex.clone();
		}
	}

	/**
	 * @param {number} now
	 * @param {number} dt
	 */
	loop(now, dt) {
		if (this.currentDirection != "paused" && !this.dead) {
			this.#nextTileProgress += dt * PLAYER_TRAVEL_SPEED;
			while (this.#nextTileProgress > 1) {
				this.#nextTileProgress -= 1;
				if (this.currentDirection == "left") {
					this.#currentPosition.x -= 1;
				} else if (this.currentDirection == "right") {
					this.#currentPosition.x += 1;
				} else if (this.currentDirection == "up") {
					this.#currentPosition.y -= 1;
				} else if (this.currentDirection == "down") {
					this.#currentPosition.y += 1;
				}
				this.#currentPositionChanged();
				this.#updateCurrentTile();
			}
		}

		if (this.#lastDeathState) {
			const dt = performance.now() - this.#lastDeathState.dieTime;
			if (dt > 600) {
				this.#permanentlyDie();
			}
		}
		if (this.#permanentlyDead) {
			const dt = performance.now() - this.#permanentlyDieTime;
			if (dt > 5_000) {
				this.connection.close();
			}
		}
	}

	#currentPositionChanged() {
		if (this.isGeneratingTrail) {
			this.#trailBounds.min.x = Math.min(this.#trailBounds.min.x, this.#currentPosition.x);
			this.#trailBounds.min.y = Math.min(this.#trailBounds.min.y, this.#currentPosition.y);
			this.#trailBounds.max.x = Math.max(this.#trailBounds.max.x, this.#currentPosition.x);
			this.#trailBounds.max.y = Math.max(this.#trailBounds.max.y, this.#currentPosition.y);
		} else {
			this.#trailBounds.min = this.#currentPosition.clone();
			this.#trailBounds.max = this.#currentPosition.clone();
		}

		if (
			this.#currentPosition.x <= 0 || this.#currentPosition.y <= 0 ||
			this.#currentPosition.x >= this.game.arena.width - 1 ||
			this.#currentPosition.y >= this.game.arena.height - 1
		) {
			this.die("area-bounds", true);
		}

		for (const player of this.game.getOverlappingTrailBoundsPlayers(this.#currentPosition)) {
			const includeLastSegment = player != this;
			if (player.pointIsInTrail(this.#currentPosition, { includeLastSegment })) {
				const killedSelf = player == this;
				player.die(killedSelf ? "self" : "player", killedSelf);
				this.game.broadcastHitLineAnimation(player, this);
			}
		}

		this.#sendRequiredEdgeChunks();
	}

	#sendRequiredEdgeChunks() {
		const chunkSize = VIEWPORT_EDGE_CHUNK_SIZE;
		const viewportSize = MIN_TILES_VIEWPORT_RECT_SIZE;
		/** @type {{x: number, y: number, w: number, h: number} | null} */
		let chunk = null;
		if (this.#currentPosition.x >= this.#lastEdgeChunkSendX + chunkSize) {
			chunk = {
				x: this.#currentPosition.x + viewportSize,
				y: this.#lastEdgeChunkSendY - viewportSize - chunkSize,
				w: chunkSize,
				h: (viewportSize + chunkSize) * 2,
			};
			this.#lastEdgeChunkSendX = this.#currentPosition.x;
		}
		if (this.#currentPosition.x <= this.#lastEdgeChunkSendX - chunkSize) {
			chunk = {
				x: this.#currentPosition.x - viewportSize - chunkSize,
				y: this.#lastEdgeChunkSendY - viewportSize - chunkSize,
				w: chunkSize,
				h: (viewportSize + chunkSize) * 2,
			};
			this.#lastEdgeChunkSendX = this.#currentPosition.x;
		}
		if (this.#currentPosition.y >= this.#lastEdgeChunkSendY + chunkSize) {
			chunk = {
				x: this.#lastEdgeChunkSendX - viewportSize - chunkSize,
				y: this.#currentPosition.y + viewportSize,
				w: (viewportSize + chunkSize) * 2,
				h: chunkSize,
			};
			this.#lastEdgeChunkSendY = this.#currentPosition.y;
		}
		if (this.#currentPosition.y <= this.#lastEdgeChunkSendY - chunkSize) {
			chunk = {
				x: this.#lastEdgeChunkSendX - viewportSize - chunkSize,
				y: this.#currentPosition.y - viewportSize - chunkSize,
				w: (viewportSize + chunkSize) * 2,
				h: chunkSize,
			};
			this.#lastEdgeChunkSendY = this.#currentPosition.y;
		}
		if (chunk) {
			const { x, y, w, h } = chunk;
			this.#connection.sendChunk({
				min: new Vec2(x, y),
				max: new Vec2(x + w, y + h),
			});
		}
	}

	/**
	 * Initiates a player death. Though at this point the death is not permanent yet.
	 * The death can still be undone by the player that killed the other player, if it turns out
	 * they moved away just in time before hitting them.
	 *
	 * @param {DeathType} deathType
	 * @param {boolean} sendPosition Whether to let the client know about the location of the player's death.
	 * If the player died from touching their own trail, or the edge of the map, we want to make it clear
	 * that this is what caused their death, so we'll change their position.
	 * But in case the player died from another player, the position doesn't really matter and we'll let the
	 * client decide where to render the player's death, to prevent a sudden change in their position.
	 */
	die(deathType, sendPosition) {
		if (this.#lastDeathState) return;
		this.#lastDeathState = {
			dieTime: performance.now(),
			type: deathType,
		};
		this.game.broadcastPlayerDeath(this, sendPosition);
	}

	#permanentlyDie() {
		if (this.#permanentlyDead) return;
		this.#permanentlyDead = true;
		this.#permanentlyDieTime = performance.now();
		this.#clearAllMyTiles();
		if (!this.#lastDeathState) {
			throw new Error("Assertion failed, no death state is set");
		}
		this.connection.sendGameOver(0, 0, 0, 0, 0, this.#lastDeathState.type, "");
	}

	removedFromGame() {
		this.#clearAllMyTiles();
	}

	#allMyTilesCleared = false;

	/**
	 * Resets all owned tiles of this player back to tiles that are not owned by anyone.
	 * This can only be called once, so after this has been called, no attempts should be
	 * made to add new tiles of this player to the arena.
	 */
	#clearAllMyTiles() {
		if (this.#allMyTilesCleared) return;
		this.#allMyTilesCleared = true;
		this.game.arena.clearAllPlayerTiles(this.id);
	}

	/**
	 * @param {Vec2} point
	 */
	pointIsInTrailBounds(point) {
		const bounds = this.#trailBounds;
		return point.x >= bounds.min.x && point.y >= bounds.min.y && point.x <= bounds.max.x && point.y <= bounds.max.y;
	}

	/**
	 * @param {Vec2} point
	 * @param {Object} options
	 * @param {boolean} [options.includeLastSegment] When true, also checks if the point lies between the
	 * last segment and the current position of the player. If the player is not generating a trail,
	 * this checks if the point lies at the exact location of the current player.
	 */
	pointIsInTrail(point, {
		includeLastSegment = true,
	} = {}) {
		if (this.isGeneratingTrail) {
			for (let i = 0; i < this.#trailVertices.length - 1; i++) {
				const start = this.#trailVertices[i];
				const end = this.#trailVertices[i + 1];
				if (checkTrailSegment(point, start, end)) return true;
			}
			if (includeLastSegment) {
				const last = this.#trailVertices.at(-1);
				if (!last) throw new Error("Assertion failed, no trail exists");
				if (checkTrailSegment(point, last, this.#currentPosition)) return true;
			}
			return false;
		} else {
			if (includeLastSegment) {
				return point.x == this.#currentPosition.x && point.y == this.#currentPosition.y;
			}
			return false;
		}
	}

	/**
	 * Checks if the type of the tile the player is currently on has changed.
	 * This can happen either because the player moved to a new coordinate,
	 * or because the current tile type got changed to that of another player.
	 */
	#updateCurrentTile() {
		const tileValue = this.#game.arena.getTileValue(this.#currentPosition);
		if (this.#currentTileType != tileValue) {
			// When the player moves out of their captured area, we will start a new trail.
			if (tileValue != this.#id && !this.isGeneratingTrail) {
				this.#trailVertices.push(this.#currentPosition.clone());
				this.game.broadcastPlayerTrail(this);
			}

			// When the player comes back into their captured area, we add a final vertex to the trail,
			// Then fill the tiles underneath the trail, and finally clear the trail.
			if (tileValue == this.#id && this.isGeneratingTrail) {
				this.#trailVertices.push(this.#currentPosition.clone());
				if (this.#allMyTilesCleared) {
					throw new Error("Assertion failed, player tiles have already been removed from the arena.");
				}
				this.game.arena.fillPlayerTrail(this.#trailVertices, this.id);
				this.game.arena.updateCapturedArea(this.id, []);
				this.#trailVertices = [];
				this.game.broadcastPlayerTrail(this);
			}

			this.#currentTileType = tileValue;
		}
	}
}
