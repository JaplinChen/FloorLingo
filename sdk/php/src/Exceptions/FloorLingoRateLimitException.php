<?php

declare(strict_types=1);

namespace FloorLingo\Exceptions;

/** 429 Too Many Requests — rate limited. */
class FloorLingoRateLimitException extends FloorLingoApiException
{
}
