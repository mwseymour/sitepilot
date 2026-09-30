<?php
/**
 * Renders a saved post in-process to catch a change that breaks the page.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

use SitePilot\Errors\Error_Contract;

/**
 * Renders each top-level block of a post, then the whole content through
 * the_content, catching exceptions and PHP errors. The desktop runs it before
 * and after a write and only rolls back when the page rendered before and
 * doesn't now, so a problem that was already there doesn't block edits.
 *
 * A true fatal (out of memory, out of time) ends the request itself; the
 * desktop treats that 500 as a failed render too.
 */
final class Render_Check {

	public const REQUEST_SCHEMA  = 'sitepilot.render-check-request/v2';
	public const RESPONSE_SCHEMA = 'sitepilot.render-check/v2';

	/**
	 * @param array<string, mixed> $params Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function check( array $params ) {
		if ( self::REQUEST_SCHEMA !== ( $params['schemaVersion'] ?? null ) ) {
			return Error_Contract::error( 'sitepilot_v2_', 'schema_invalid', __( 'The render check request is invalid.', 'sitepilot' ), 400 );
		}
		$post_id = (int) ( $params['postId'] ?? 0 );
		$post    = $post_id > 0 ? get_post( $post_id ) : null;
		if ( ! $post instanceof \WP_Post ) {
			return Error_Contract::error( 'sitepilot_v2_', 'schema_invalid', __( 'The post to render was not found.', 'sitepilot' ), 404 );
		}
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return Error_Contract::error( 'sitepilot_v2_', 'permission_denied', __( 'The SitePilot WordPress user cannot edit this post, so it cannot render it.', 'sitepilot' ), 403 );
		}
		return array( 'schemaVersion' => self::RESPONSE_SCHEMA, 'postId' => $post_id ) + self::render( $post );
	}

	/**
	 * @return array{outcome: string, block?: array{name: string, index: int}, message?: string}
	 */
	public static function render( \WP_Post $post ): array {
		$previous_post   = $GLOBALS['post'] ?? null;
		$GLOBALS['post'] = $post;
		setup_postdata( $post );
		try {
			foreach ( parse_blocks( $post->post_content ) as $index => $block ) {
				if ( null === ( $block['blockName'] ?? null ) ) {
					continue;
				}
				$failure = self::capture( static fn(): string => render_block( $block ) )['failure'];
				if ( null !== $failure ) {
					return array(
						'outcome' => 'render_error',
						'block'   => array(
							'name'  => (string) $block['blockName'],
							'index' => (int) $index,
						),
						'message' => $failure,
					);
				}
			}
			// Some failures only happen in the_content filters, outside any block.
			$whole = self::capture( static fn(): string => (string) apply_filters( 'the_content', $post->post_content ) );
			if ( null !== $whole['failure'] ) {
				return array( 'outcome' => 'render_error', 'message' => $whole['failure'] );
			}
			if ( '' !== trim( $post->post_content ) && '' === trim( wp_strip_all_tags( $whole['html'], true ) ) && ! preg_match( '/<(img|video|iframe|svg|figure)\b/i', $whole['html'] ) ) {
				return array( 'outcome' => 'empty_output', 'message' => 'The post has content but rendered nothing.' );
			}
			return array( 'outcome' => 'ok' );
		} finally {
			$GLOBALS['post'] = $previous_post;
			wp_reset_postdata();
		}
	}

	/**
	 * Runs a render, capturing output, exceptions and PHP errors. Warnings,
	 * notices and deprecations are ignored: many themes raise them without the
	 * page breaking.
	 *
	 * @param callable(): string $render Render callback.
	 * @return array{html: string, failure: ?string}
	 */
	private static function capture( callable $render ): array {
		$failure = null;
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_set_error_handler
		set_error_handler(
			static function ( int $severity, string $message ) use ( &$failure ): bool {
				if ( $severity & ( E_USER_ERROR | E_RECOVERABLE_ERROR ) ) {
					$failure = $failure ?? 'A PHP error was raised while rendering: ' . substr( $message, 0, 300 );
					return true;
				}
				return false;
			}
		);
		$level = ob_get_level();
		ob_start();
		try {
			$html  = $render();
			$html .= (string) ob_get_clean();
		} catch ( \Throwable $error ) {
			while ( ob_get_level() > $level ) {
				ob_end_clean();
			}
			$html    = '';
			$failure = 'Rendering threw an error: ' . substr( $error->getMessage(), 0, 300 );
		} finally {
			restore_error_handler();
		}
		return array(
			'html'    => $html,
			'failure' => $failure,
		);
	}
}
